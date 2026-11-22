/* SPDX-License-Identifier: GPL-2.0-or-later */
/* RP1 DesignWare I2C1 and the WM1302 STTS751 at 7-bit address 0x39. */
#ifndef OSI_WM1302_I2C_H
#define OSI_WM1302_I2C_H

#include "hat-atecc.h"

typedef struct WmI2c {
    HatAtecc atecc;
    MemoryRegion mmio;
    qemu_irq irq;
    uint32_t regs[64], pending;
    uint8_t sensor[256], pointer, rx[16], head, count;
    bool addressed;
} WmI2c;

static uint32_t wm_i2c_intr(WmI2c *s)
{
    return s->pending | (s->regs[0x6c / 4] & 1 ? 1u << 4 : 0) |
           (s->count > s->regs[0x38 / 4] ? 1u << 2 : 0);
}

static void wm_i2c_irq(WmI2c *s)
{
    qemu_set_irq(s->irq, (wm_i2c_intr(s) & s->regs[0x30 / 4]) != 0);
}

static uint64_t wm_i2c_read(void *opaque, hwaddr offset, unsigned size)
{
    WmI2c *s = opaque;
    switch (offset) {
    case 0x10:
        if (s->count) {
            uint8_t val = s->rx[s->head++ % 16];
            s->count--;
            wm_i2c_irq(s);
            return val;
        }
        return 0;
    case 0x2c: return wm_i2c_intr(s) & s->regs[0x30 / 4];
    case 0x34: return wm_i2c_intr(s);
    case 0x40: s->pending = 0; break; /* CLR_INTR */
    case 0x54: s->pending &= ~(1u << 6); break; /* CLR_TX_ABRT */
    case 0x60: s->pending &= ~(1u << 9); break; /* CLR_STOP_DET */
    case 0x70: return 6 | (s->count ? 8 : 0);
    case 0x78: return s->count;
    case 0x80: return (s->pending >> 6) & 1; /* 7-bit address NACK */
    case 0x9c: return s->regs[0x6c / 4] & 1;
    case 0xf4: return (15 << 16) | (15 << 8) | 0xae;
    case 0xf8: return 0x3131312a;
    case 0xfc: return 0x44570140;
    default: return offset < sizeof(s->regs) ? s->regs[offset / 4] : 0;
    }
    wm_i2c_irq(s);
    return 0;
}

static void wm_i2c_write(void *opaque, hwaddr offset, uint64_t value, unsigned size)
{
    WmI2c *s = opaque;
    if (offset >= sizeof(s->regs)) {
        return;
    }
    s->regs[offset / 4] = value;
    if (offset == 0x6c && !(value & 1)) {
        s->count = s->head = 0;
        s->addressed = false;
    }
    if (offset == 0x10 && (s->regs[0x6c / 4] & 1)) {
        unsigned target = s->regs[1] & 0x3ff;
        if (target == 0 && !(value & 0x100) && !(value & 0xff)) {
            atecc_wake(&s->atecc);
            s->pending |= 1u << 6; /* the general-call wake token is NACKed */
        } else if (target == 0x59 && qemu_clock_get_us(QEMU_CLOCK_VIRTUAL) < s->atecc.awake_until) {
            if (value & (1u << 8)) {
                if (s->count < 16) {
                    uint8_t byte = s->atecc.index < s->atecc.response[0] ?
                        s->atecc.response[s->atecc.index++] : 0xff;
                    s->rx[(s->head + s->count++) % 16] = byte;
                }
            } else {
                atecc_write(&s->atecc, value, !s->addressed || (value & (1u << 10)),
                            value & (1u << 9));
                s->addressed = true;
            }
        } else if (target != 0x39) {
            s->pending |= 1u << 6;
        } else if (value & (1u << 8)) {
            if (s->count < 16) {
                s->rx[(s->head + s->count++) % 16] = s->sensor[s->pointer++];
            }
        } else if (!s->addressed || (value & (1u << 10))) {
            s->pointer = value;
            s->addressed = true;
        } else {
            if (s->pointer >= 3 && s->pointer <= 0x22) {
                s->sensor[s->pointer] = value;
            }
            s->pointer++;
        }
        if (value & (1u << 9)) {
            s->pending |= 1u << 9;
            s->addressed = false;
        }
    }
    wm_i2c_irq(s);
}

static const MemoryRegionOps wm_i2c_ops = {
    .read = wm_i2c_read,
    .write = wm_i2c_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
};
#endif
