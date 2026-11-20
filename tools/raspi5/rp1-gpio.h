/* SPDX-License-Identifier: GPL-2.0-or-later */
/* RP1 IO_BANK, RIO and PADS register banks with atomic alias windows. */
#ifndef OSI_RP1_GPIO_H
#define OSI_RP1_GPIO_H

typedef struct Rp1Gpio {
    MemoryRegion mmio;
    uint32_t regs[3][3][1024];
    WmSpiState *spi;
} Rp1Gpio;

static uint32_t *rp1_gpio_word(Rp1Gpio *g, hwaddr offset)
{
    unsigned block = offset >> 16;
    unsigned bank = (offset >> 14) & 3;
    return (block < 3 && bank < 3) ?
        &g->regs[block][bank][(offset & 0xfff) / 4] : NULL;
}

static uint64_t rp1_gpio_read(void *opaque, hwaddr offset, unsigned size)
{
    Rp1Gpio *g = opaque;
    uint32_t *word = rp1_gpio_word(g, offset);
    if (!word) {
        return 0;
    }
    if ((offset >> 16) == 1 && (offset & 0xfff) == 8) {
        return word[-2] & word[-1]; /* RIO_IN reflects enabled outputs */
    }
    return *word;
}

static void rp1_gpio_write(void *opaque, hwaddr offset, uint64_t value, unsigned size)
{
    Rp1Gpio *g = opaque;
    uint32_t *word = rp1_gpio_word(g, offset);
    if (!word) {
        return;
    }
    switch ((offset >> 12) & 3) {
    case 0: *word = value; break;
    case 1: *word ^= value; break;
    case 2: *word |= value; break;
    case 3: *word &= ~value; break;
    }
    if ((offset >> 14) == 4) {
        uint32_t pins = g->regs[1][0][0] & g->regs[1][0][1];
        /* The HAT regulator enable is tied to 5 V. GPIO18 is AUX_BUSY. */
        bool active = !(pins & (1u << 17));
        if (!active && g->spi->active) {
            wm_chip_reset(g->spi);
        }
        if (active && !g->spi->active) {
            g->spi->reset_us = qemu_clock_get_us(QEMU_CLOCK_VIRTUAL);
        }
        g->spi->active = active;
    }
}

static const MemoryRegionOps rp1_gpio_ops = {
    .read = rp1_gpio_read,
    .write = rp1_gpio_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid = { .min_access_size = 4, .max_access_size = 4 },
};
#endif
