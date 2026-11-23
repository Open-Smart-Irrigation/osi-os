/* SPDX-License-Identifier: GPL-2.0-or-later */
#ifndef OSI_BCM2712_WATCHDOG_H
#define OSI_BCM2712_WATCHDOG_H
#include "system/runstate.h"

typedef struct Pi5Watchdog {
    MemoryRegion mmio;
    QEMUTimer *timer;
    uint32_t rstc, rsts, ticks;
    int64_t deadline;
} Pi5Watchdog;

static void pi5_watchdog_expire(void *opaque)
{
    Pi5Watchdog *s = opaque;
    if ((s->rsts & 0x555) == 0x555) {
        qemu_system_shutdown_request(SHUTDOWN_CAUSE_GUEST_SHUTDOWN);
    } else {
        s->rsts |= 0x40;
        qemu_system_reset_request(SHUTDOWN_CAUSE_GUEST_RESET);
    }
}

static uint64_t pi5_watchdog_read(void *opaque, hwaddr offset, unsigned size)
{
    Pi5Watchdog *s = opaque;
    switch (offset) {
    case 0x1c: return s->rstc;
    case 0x20: return s->rsts;
    case 0x24:
        if (timer_pending(s->timer)) {
            int64_t left = MAX(0, s->deadline - qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL));
            return DIV_ROUND_UP(left * 65536, NANOSECONDS_PER_SECOND);
        }
        return s->ticks;
    default: return 0;
    }
}

static void pi5_watchdog_write(void *opaque, hwaddr offset, uint64_t value, unsigned size)
{
    Pi5Watchdog *s = opaque;
    if ((value >> 24) != 0x5a) {
        return;
    }
    switch (offset) {
    case 0x1c:
        s->rstc = value & 0xffffff;
        break;
    case 0x20:
        s->rsts = value & 0xffffff;
        return;
    case 0x24:
        s->ticks = value & 0xfffff;
        break;
    default:
        return;
    }
    if ((s->rstc & 0x30) == 0x20) {
        s->deadline = qemu_clock_get_ns(QEMU_CLOCK_VIRTUAL) +
                      (int64_t)s->ticks * NANOSECONDS_PER_SECOND / 65536;
        timer_mod(s->timer, s->deadline);
    } else {
        timer_del(s->timer);
    }
}

static const MemoryRegionOps pi5_watchdog_ops = {
    .read = pi5_watchdog_read, .write = pi5_watchdog_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid = {.min_access_size = 4, .max_access_size = 4},
};
#endif
