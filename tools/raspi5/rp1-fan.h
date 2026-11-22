/* SPDX-License-Identifier: GPL-2.0-or-later */
/* RP1 PWM1 and the board's firmware-populated fan tachometer register. */
#ifndef OSI_RP1_FAN_H
#define OSI_RP1_FAN_H

typedef struct Pi5Fan {
    MemoryRegion pwm, avs;
    uint32_t regs[64];
} Pi5Fan;

static uint64_t fan_read(void *opaque, hwaddr addr, unsigned size)
{
    Pi5Fan *fan = opaque;
    if (addr == 0x3c) {
        uint32_t period = fan->regs[0x48 / 4];
        uint32_t duty = fan->regs[0x50 / 4];
        /* Linear test fan with a 5000 RPM full-duty operating point. */
        return period && (fan->regs[0] & 8) ?
            5000ULL * MIN(period, duty) / period : 0;
    }
    return fan->regs[addr / 4];
}

static void fan_write(void *opaque, hwaddr addr, uint64_t value, unsigned size)
{
    Pi5Fan *fan = opaque;
    fan->regs[addr / 4] = addr == 0 ? value & ~(1u << 31) : value;
}

static uint64_t avs_read(void *opaque, hwaddr addr, unsigned size)
{
    /* The image's slope and offset convert this sample to 46850 mC. */
    return addr == 0x200 ? (1 << 16) | 733 : 0;
}

static const MemoryRegionOps fan_ops = {
    .read = fan_read, .write = fan_write, .endianness = DEVICE_LITTLE_ENDIAN,
    .valid = { .min_access_size = 4, .max_access_size = 4 },
};
static const MemoryRegionOps avs_ops = {
    .read = avs_read, .endianness = DEVICE_LITTLE_ENDIAN,
    .valid = { .min_access_size = 4, .max_access_size = 4 },
};
#endif
