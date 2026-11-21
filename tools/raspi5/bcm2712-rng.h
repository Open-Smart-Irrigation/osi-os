/* SPDX-License-Identifier: GPL-2.0-or-later */
/* RNG200 register interface with QEMU guest randomness as the bit source. */
#ifndef OSI_BCM2712_RNG_H
#define OSI_BCM2712_RNG_H
#include "qemu/guest-random.h"

typedef struct Pi5Rng {
    MemoryRegion mmio;
    uint32_t reg[10];
    int64_t started, sampled;
    unsigned words;
} Pi5Rng;

static void pi5_rng_update(Pi5Rng *s, int64_t now)
{
    if (!(s->reg[0] & 0x1fff) || s->reg[1] || s->reg[2]) {
        s->words = 0;
        s->started = s->sampled = now;
        return;
    }
    /* Approximate a 1-Mbit/s entropy source on the virtual clock. */
    int64_t generated = (now - s->sampled) / 32;
    s->words = MIN(16, s->words + generated);
    s->sampled += generated * 32;
}

static uint64_t pi5_rng_read(void *opaque, hwaddr offset, unsigned size)
{
    Pi5Rng *s = opaque;
    int64_t now = qemu_clock_get_us(QEMU_CLOCK_VIRTUAL);
    pi5_rng_update(s, now);
    if (offset == 0xc) {
        return (uint32_t)(now - s->started);
    }
    if (offset == 0x24) {
        return (s->reg[9] & ~255u) | s->words;
    }
    if (offset == 0x20) {
        uint32_t word = 0;
        if (s->words) {
            qemu_guest_getrandom_nofail(&word, sizeof(word));
            s->words--;
        }
        return word;
    }
    return s->reg[offset / 4];
}

static void pi5_rng_write(void *opaque, hwaddr offset, uint64_t value, unsigned size)
{
    Pi5Rng *s = opaque;
    pi5_rng_update(s, qemu_clock_get_us(QEMU_CLOCK_VIRTUAL));
    if (offset == 0x18) {
        s->reg[6] &= ~value;
    } else if (offset != 0xc && offset != 0x20) {
        s->reg[offset / 4] = value;
    }
}

static const MemoryRegionOps pi5_rng_ops = {
    .read = pi5_rng_read, .write = pi5_rng_write, .endianness = DEVICE_LITTLE_ENDIAN,
    .valid = {.min_access_size = 4, .max_access_size = 4},
};
#endif
