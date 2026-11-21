/* SPDX-License-Identifier: GPL-2.0-or-later */
/* Register interface of the RP1 DesignWare APB SSI master and SX1302 on CS0. */
#ifndef WM1302_SPI_H
#define WM1302_SPI_H

#include "chardev/char-fe.h"
#include "chardev/char.h"
#include "hw/irq.h"
#include "qemu/timer.h"
#include "system/memory.h"

#define SSI_FIFO_DEPTH 64
#define WM_AIR_RECEIPT 254

/* The SX1250 command address is 16 bits. The modeled control registers
 * used by the SX1302 HAL are in the first 4 KiB. */
typedef struct Sx1250State {
    uint8_t regs[4096];
    uint8_t mode;
    bool image_error;
} Sx1250State;

typedef struct WmTx {
    QEMUTimer *timer;
    struct WmSpiState *spi;
    unsigned chain;
    uint8_t status;
} WmTx;

typedef struct WmSpiState {
    MemoryRegion mmio;
    qemu_irq irq;
    uint32_t ctrl, divisor, selected, mask, tx_threshold, rx_threshold;
    uint8_t rx[SSI_FIFO_DEPTH], head, count;
    bool enabled, write, active;
    uint32_t phase;
    uint8_t mux, otp_address;
    uint16_t address;
    Sx1250State radio[2];
    uint8_t opcode, image_start;
    uint8_t program_ram[0x4000], regs[0x1200];
    CharBackend air;
    WmTx tx[2];
    uint8_t frame[263], fifo[4096];
    unsigned frame_len, fifo_head, fifo_count;
    uint32_t timestamp, pps, ndf, remaining;
    int64_t reset_us;
} WmSpiState;

static void wm_chip_reset(WmSpiState *spi)
{
    for (unsigned i = 0; i < 2; i++) {
        timer_del(spi->tx[i].timer);
        spi->tx[i].status = 0x80;
    }
    memset(spi->radio, 0, sizeof(spi->radio));
    memset(spi->program_ram, 0, sizeof(spi->program_ram));
    memset(spi->regs, 0, sizeof(spi->regs));
    spi->fifo_count = spi->fifo_head = 0;
    spi->otp_address = 0;
    spi->phase = 0;
    spi->timestamp = spi->pps = spi->address = spi->frame_len = 0;
}

static uint8_t sx1250_exchange(WmSpiState *s, uint8_t byte)
{
    Sx1250State *r = &s->radio[s->mux - 1];
    unsigned phase = s->phase++;
    if (phase == 1) {
        s->opcode = byte;
        return 0;
    }
    switch (s->opcode) {
    case 0xc0: /* GET_STATUS */
        return r->mode << 4;
    case 0x80: /* SET_STANDBY */
        if (phase == 2 && byte <= 1) {
            r->mode = 2 + byte;
        }
        break;
    case 0x82: /* SET_RX */
        if (phase == 4) {
            r->mode = 5;
        }
        break;
    case 0x98: /* CALIBRATE_IMAGE, US915 RF filter */
        if (phase == 2) {
            s->image_start = byte;
        } else if (phase == 3) {
            r->image_error = s->image_start != 0xe1 || byte != 0xe9;
        }
        break;
    case 0x17: /* GET_DEVICE_ERRORS */
        return phase == 4 && r->image_error ? 0x10 : 0;
    case 0x86: /* SET_RF_FREQUENCY, MSB first */
        if (phase < 6) {
            r->regs[0x88b + phase - 2] = byte;
        }
        break;
    case 0x0d: /* WRITE_REGISTER */
    case 0x1d: /* READ_REGISTER */
        if (phase == 2) {
            s->address = byte << 8;
        } else if (phase == 3) {
            s->address |= byte;
        } else if (s->address < sizeof(r->regs)) {
            if (s->opcode == 0x0d) {
                r->regs[s->address++] = byte;
            } else if (phase >= 5) {
                return r->regs[s->address++];
            }
        }
        break;
    }
    return 0;
}

/* Test-medium frames are length, channel, spreading factor, then PHYPayload.
 * Accepted multi-SF uplinks enter the same hardware FIFO the HAL polls. */
static int wm_air_space(void *opaque)
{
    return 258;
}

/* Each multi-SF IF is a signed 13-bit offset from its selected SX1250.
 * Compare nominal carriers within one IF tuning step (15625/32 Hz). */
static unsigned wm_find_channel(WmSpiState *s, uint32_t hz, uint8_t bandwidth)
{
    if (bandwidth != 0) {
        return 8; /* Multi-SF channels use 125 kHz. */
    }
    for (unsigned channel = 0; channel < 8; channel++) {
        unsigned chain = extract32(s->regs[0x610], channel, 1);
        Sx1250State *rf = &s->radio[chain];
        if (!(s->regs[0x621] & (1u << channel)) || rf->mode != 5) {
            continue;
        }
        uint32_t pll = ldl_be_p(rf->regs + 0x88b);
        int64_t center = ((uint64_t)pll * 32000000) >> 25;
        int32_t offset = sextract32(lduw_be_p(s->regs + 0x600 + channel * 2), 0, 13);
        int64_t error = center + (int64_t)offset * 15625 / 32 - hz;
        if (error >= -489 && error <= 489) {
            return channel;
        }
    }
    return 8;
}

static bool wm_queue_rx(WmSpiState *s)
{
    uint8_t size = s->frame[0], channel = s->frame[1], sf = s->frame[2];
    const uint8_t *payload = s->frame + 3;
    if (channel >= WM_AIR_RECEIPT) {
        channel = wm_find_channel(s, ldl_be_p(payload), payload[4]);
        payload += 5;
    }
    uint8_t record[278] = {0xa5, 0xc0, size, channel, (sf << 4) | 3, channel};
    uint16_t crc = 0;
    unsigned len = size + 23;
    /* HAL: CORR_EN (0x5821) has one bit per multi-SF IF; CORR_SF_EN (0x5822)
     * uses bit 0 for SF5 through bit 7 for SF12. */
    if (!size || !s->active || !(s->regs[0x405] & 2) || channel > 7 || sf < 5 || sf > 12 ||
        !(s->regs[0x621] & (1u << channel)) || !(s->regs[0x622] & (1u << (sf - 5))) ||
        len + s->fifo_count > sizeof(s->fifo)) {
        return false;
    }
    memcpy(record + 9, payload, size);
    for (unsigned i = 0; i < size; i++) {
        for (unsigned bit = 0; bit < 8; bit++) {
            crc = (crc << 1) ^ (crc & 0x8000 ? 0x1021 : 0);
        }
        crc ^= payload[i];
    }
    record[size + 10] = 32; /* fixture SNR, quarter-dB units */
    record[size + 11] = record[size + 12] = 125;
    uint32_t ticks = (qemu_clock_get_us(QEMU_CLOCK_VIRTUAL) - s->reset_us) * 32;
    stl_le_p(record + size + 15, ticks);
    stw_le_p(record + size + 19, crc);
    for (unsigned i = 0; i + 1 < len; i++) {
        record[len - 1] += record[i];
    }
    for (unsigned i = 0; i < len; i++) {
        s->fifo[(s->fifo_head + s->fifo_count++) % sizeof(s->fifo)] = record[i];
    }
    return true;
}

static void wm_air_write(WmSpiState *s, const uint8_t *frame, int len)
{
    if (qemu_chr_fe_backend_open(&s->air) &&
        qemu_chr_fe_write(&s->air, frame, len) != len) {
        /* A stalled observer must not stop the virtual CPU or leave a
         * partial packet in a stream that will receive later frames. */
        qemu_chr_fe_disconnect(&s->air);
    }
}

static void wm_air_read(void *opaque, const uint8_t *bytes, int count)
{
    WmSpiState *s = opaque;
    for (int i = 0; i < count; i++) {
        s->frame[s->frame_len++] = bytes[i];
        if (s->frame_len < 3) {
            continue;
        }
        unsigned header = s->frame[1] >= WM_AIR_RECEIPT ? 8 : 3;
        if (s->frame_len == s->frame[0] + header) {
            bool receipt_requested = s->frame[1] == WM_AIR_RECEIPT;
            bool delivered = wm_queue_rx(s);
            s->frame_len = 0;
            if (receipt_requested) {
                /* Report the number of packets added to the HAL FIFO by
                 * this request. Legacy channel 255 never produces a receipt. */
                uint8_t receipt[] = {1, WM_AIR_RECEIPT, 0, delivered};
                wm_air_write(s, receipt, sizeof(receipt));
            }
        }
    }
}

static void wm_air_event(void *opaque, QEMUChrEvent event)
{
    WmSpiState *s = opaque;
    if (event == CHR_EVENT_CLOSED) {
        s->frame_len = 0;
    }
}

/* Behavioral interface of the two firmware images shipped with the OSI HAL.
 * Reject an unknown program instead of acknowledging its startup sequence. */
static void wm_mcu_start(WmSpiState *s, bool agc)
{
    const char *expected = agc ?
        "8f612e878b946b8c7cc59a5fc27ad33bb18ab92ad6e291d873f5d6bb7daae0d4" :
        "a6f542395e29cd258917f5948d1067ab18e3cf08ce5ee250e2caa08539f80fd0";
    unsigned base = agc ? 0x580 : 0xe80; /* offset from register 0x5200 */
    g_autofree char *digest = g_compute_checksum_for_data(G_CHECKSUM_SHA256,
                                      s->program_ram + (agc ? 0 : 8192), 8192);
    if (strcmp(digest, expected) == 0) {
        s->regs[base + 1] = 1;
        s->regs[base + (agc ? 16 : 13)] = agc ? 10 : 2;
    }
}

/* LoRa packet duration in virtual microseconds, from the modem configuration. */
static unsigned wm_airtime(const uint8_t *reg)
{
    unsigned sf = MIN(MAX(reg[96] & 15, 5), 12);
    unsigned bw = MIN(MAX(reg[96] >> 4, 4), 6);
    unsigned symbol_us = (1u << sf) * 8 / (1u << (bw - 4));
    unsigned divisor = 4 * (sf - 2 * (symbol_us >= 16000));
    int bits = 8 * reg[99] - 4 * sf + 28 + 16 * (reg[98] & 1) - 20 * ((reg[98] >> 1) & 1);
    unsigned symbols = 8 + DIV_ROUND_UP(MAX(bits, 0), divisor) * (4 + (reg[97] & 7));
    return ((reg[102] | reg[103] << 8) + symbols + 4) * symbol_us + symbol_us / 4;
}

static void wm_tx_event(void *opaque)
{
    WmTx *tx = opaque;
    WmSpiState *s = tx->spi;
    uint8_t *reg = s->regs + tx->chain * 0x200;
    if (tx->status == 0x91) {
        uint8_t len = reg[99];
        uint8_t frame[258] = {len, tx->chain, reg[96] & 15};
        memcpy(frame + 3, reg + 256, len);
        wm_air_write(s, frame, len + 3);
        tx->status = 0x30;
        timer_mod(tx->timer, qemu_clock_get_us(QEMU_CLOCK_VIRTUAL) + wm_airtime(reg));
    } else {
        tx->status = 0x80;
    }
}

static void wm_tx_trigger(WmTx *tx, uint8_t *reg, uint8_t previous)
{
    uint8_t rising = *reg & ~previous;
    int64_t now = qemu_clock_get_us(QEMU_CLOCK_VIRTUAL);
    int64_t elapsed = now - tx->spi->reset_us;
    if ((*reg & 8) || !(*reg & 7)) {
        timer_del(tx->timer);
        tx->status = 0x80;
    } else if (rising & 7) {
        uint32_t delay_us = 0;
        if (rising & 2) {
            uint32_t ticks = ldl_be_p(reg + 1) - (uint32_t)(elapsed * 32);
            delay_us = ticks / 32;
        } else if (rising & 4) {
            delay_us = 1000000 - elapsed % 1000000;
        }
        tx->status = 0x91;
        timer_mod(tx->timer, now + delay_us + lduw_be_p(reg + 5) / 32);
    }
}

static void wm_control_write(WmSpiState *s, uint16_t address, uint8_t byte)
{
    uint8_t *reg = &s->regs[address - 0x5200];
    uint8_t previous = *reg;
    *reg = byte;
    switch (address) {
    case 0x5200:
    case 0x5400:
        wm_tx_trigger(&s->tx[address == 0x5400], reg, previous);
        break;
    case 0x5780:
    case 0x6080:
        if (byte & 4) {
            reg[1] = 0;
        } else if ((previous & 4) && !(byte & 2)) {
            wm_mcu_start(s, address == 0x5780);
        }
        break;
    case 0x5789: { /* Mailbox 3 commits the AGC configuration step. */
        unsigned step = s->regs[0x581];
        unsigned command = step == 1 ? 0x80 : step == 2 ? 0x20 : step;
        if (step >= 1 && step <= 11 && byte == command) {
            memcpy(reg + 5, reg + 1, 3);
            s->regs[0x581] = step == 11 ? 15 : step + 1;
        }
        break;
    }
    case 0x608a: /* ARB resume following configuration */
        if (byte == 1 && s->regs[0xe81] == 1) {
            s->regs[0xe81] = 0;
        }
        break;
    }
}

static uint8_t wm1302_exchange(WmSpiState *s, uint8_t value)
{
    /* Locally administered test identifier stored MSB first in SX1302 OTP. */
    static const uint8_t eui[] = { 0x02, 0x00, 0x00, 0xff, 0xfe, 0x00, 0x00, 0x01 };
    if (!s->active) {
        return 0xff;
    }
    if (s->phase && (s->mux == 1 || s->mux == 2)) {
        return sx1250_exchange(s, value);
    }
    switch (s->phase++) {
    case 0:
        s->mux = value;
        return 0;
    case 1:
        s->write = value & 0x80;
        s->address = (value & 0x7f) << 8;
        return 0;
    case 2:
        s->address |= value;
        return 0;
    case 3:
        if (!s->write) {
            return 0; /* address-to-data turnaround */
        }
        break;
    }
    if (s->mux != 0) {
        return 0;
    }
    if (s->address < sizeof(s->program_ram)) {
        if (s->write) {
            s->program_ram[s->address] = value;
        }
        return s->program_ram[s->address++];
    }
    uint16_t address = s->address++;
    if (address >= 0x4000 && address < 0x5000 && !s->write && s->fifo_count) {
        uint8_t byte = s->fifo[s->fifo_head];
        s->fifo_head = (s->fifo_head + 1) % sizeof(s->fifo);
        s->fifo_count--;
        return byte;
    }
    switch (address) {
    case 0x58c8: return s->fifo_count >> 8;
    case 0x58c9: return s->fifo_count;
    case 0x5211:
    case 0x5411:
        return s->tx[address == 0x5411].status;
    case 0x5606:
        return 0x10; /* COMMON_VERSION */
    case 0x6180:
        if (s->write) {
            s->otp_address = value;
        }
        return s->otp_address;
    case 0x6181:
        if (s->otp_address < sizeof(eui)) {
            return eui[s->otp_address];
        }
        return s->otp_address == 0xd0 ? 2 : 0; /* ChipModelID */
    default:
        if (address >= 0x6101 && address <= 0x6104) {
            return s->pps >> (8 * (0x6104 - address));
        }
        if (address == 0x6105) {
            s->timestamp = (qemu_clock_get_us(QEMU_CLOCK_VIRTUAL) - s->reset_us) * 32;
        }
        if (address >= 0x6105 && address <= 0x6108) {
            return s->timestamp >> (8 * (0x6108 - address));
        }
        if (address >= 0x5200 && address < 0x6200) {
            if (s->write) {
                wm_control_write(s, address, value);
            }
            return s->regs[address - 0x5200];
        }
        return 0;
    }
}

static void wm_spi_receive(WmSpiState *s)
{
    while (s->remaining && s->count < SSI_FIFO_DEPTH) {
        s->rx[(s->head + s->count) % SSI_FIFO_DEPTH] =
            s->selected == 1 ? wm1302_exchange(s, 0) : 0xff;
        s->count++;
        s->remaining--;
    }
}

static uint32_t wm_spi_interrupts(WmSpiState *s)
{
    /* Byte transfers complete synchronously. The transmit FIFO stays empty. */
    return s->enabled ? 1 | ((s->count > s->rx_threshold) << 4) : 0;
}

static void wm_spi_irq(WmSpiState *s)
{
    qemu_set_irq(s->irq, (s->mask & wm_spi_interrupts(s)) != 0);
}

static uint64_t wm_spi_read(void *opaque, hwaddr addr, unsigned size)
{
    WmSpiState *s = opaque;
    switch (addr) {
    case 0x00: return s->ctrl;
    case 0x04: return s->ndf;
    case 0x08: return s->enabled;
    case 0x10: return s->selected;
    case 0x14: return s->divisor;
    case 0x18: return s->tx_threshold;
    case 0x1c: return s->rx_threshold;
    case 0x24: return s->count;
    case 0x28: return 6 | (s->count ? 8 : 0) | (s->count == SSI_FIFO_DEPTH ? 16 : 0);
    case 0x2c: return s->mask;
    case 0x30: return wm_spi_interrupts(s) & s->mask;
    case 0x34: return wm_spi_interrupts(s);
    case 0x5c: return 0x3430322a; /* DW_apb_ssi 4.02a */
    case 0x60:
        if (s->count) {
            uint8_t value = s->rx[s->head++];
            s->head %= SSI_FIFO_DEPTH;
            s->count--;
            wm_spi_receive(s);
            wm_spi_irq(s);
            return value;
        }
        break;
    }
    return 0;
}

static void wm_spi_write(void *opaque, hwaddr addr, uint64_t value, unsigned size)
{
    WmSpiState *s = opaque;
    switch (addr) {
    case 0x00: s->ctrl = value; break;
    case 0x04: s->ndf = value & 0xffff; break;
    case 0x08:
        s->enabled = value & 1;
        if (!s->enabled) {
            s->head = s->count = s->remaining = 0;
        }
        break;
    case 0x10:
        if (s->selected != value) {
            s->phase = 0;
        }
        s->selected = value;
        break;
    case 0x14: s->divisor = value; break;
    case 0x18: s->tx_threshold = MIN(value, SSI_FIFO_DEPTH - 1); break;
    case 0x1c: s->rx_threshold = MIN(value, SSI_FIFO_DEPTH - 1); break;
    case 0x2c: s->mask = value; break;
    case 0x60:
        if (s->enabled && s->selected && s->count < SSI_FIFO_DEPTH) {
            unsigned mode = (s->ctrl >> 8) & 3;
            if (mode == 2) {
                s->remaining = s->ndf + 1;
                wm_spi_receive(s);
            } else {
                uint8_t byte = s->selected == 1 ? wm1302_exchange(s, value) : 0xff;
                if (mode != 1) {
                    s->rx[(s->head + s->count) % SSI_FIFO_DEPTH] = byte;
                    s->count++;
                }
            }
        }
        break;
    }
    wm_spi_irq(s);
}

static const MemoryRegionOps wm_spi_ops = {
    .read = wm_spi_read,
    .write = wm_spi_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
};
#endif
