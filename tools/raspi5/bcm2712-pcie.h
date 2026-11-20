/* SPDX-License-Identifier: GPL-2.0-or-later */
/* BCM2712 internal root port and RP1 configuration-space discovery. */
#ifndef OSI_BCM2712_PCIE_H
#define OSI_BCM2712_PCIE_H
typedef struct Pi5Pcie {
    MemoryRegion reset_bank, rescal, mmio, mip, table, bar1, sram, sysinfo, apbs;
    qemu_irq destination[64];
    uint32_t vector[64][4], config[64];
    bool asserted[64], waiting[64];
    uint64_t pending;
    uint32_t regs[0xa000 / 4], endpoint[1024];
    uint32_t reset_status[2], calibration;
    uint16_t phy[32];
} Pi5Pcie;

static void rp1_notify(Pi5Pcie *p, unsigned n)
{
    uint32_t *v = p->vector[n];
    if (!(p->config[n] & 1) || p->waiting[n]) {
        return;
    }
    if (!(p->endpoint[0x50 / 4] & (1u << 31)) ||
        (p->endpoint[0x50 / 4] & (1u << 30)) || (v[3] & 1)) {
        p->pending |= UINT64_C(1) << n;
        return;
    }
    if (v[1] == 0xff && v[0] == 0xfffff000 && v[2] < 64) {
        p->pending &= ~(UINT64_C(1) << n);
        p->waiting[n] = p->config[n] & 8;
        const uint8_t *mip = memory_region_get_ram_ptr(&p->mip);
        uint32_t mask = ldl_le_p(mip + 0x40 + (v[2] / 32) * 16);
        if (!(mask & (1u << (v[2] % 32)))) {
            qemu_irq_pulse(p->destination[v[2]]);
        }
    }
}

static void rp1_input(void *opaque, int n, int level)
{
    Pi5Pcie *p = opaque;
    bool rising = level && !p->asserted[n];
    p->asserted[n] = level;
    if (rising) {
        rp1_notify(p, n);
    }
}

static uint64_t rp1_table_read(void *opaque, hwaddr a, unsigned size)
{
    Pi5Pcie *p = opaque;
    if (a < sizeof(p->vector)) {
        return p->vector[a / 16][(a / 4) % 4];
    }
    return a == 0x1000 ? (uint32_t)p->pending : a == 0x1004 ? p->pending >> 32 : 0;
}

static void rp1_table_write(void *opaque, hwaddr a, uint64_t val, unsigned size)
{
    Pi5Pcie *p = opaque;
    if (a < sizeof(p->vector)) {
        unsigned n = a / 16;
        p->vector[n][(a / 4) % 4] = val;
        if (p->pending & (UINT64_C(1) << n)) {
            rp1_notify(p, n);
        }
    }
}

static const MemoryRegionOps rp1_table_ops = {
    .read = rp1_table_read, .write = rp1_table_write, .endianness = DEVICE_LITTLE_ENDIAN,
    .impl = {.min_access_size = 4, .max_access_size = 4},
};

static uint64_t rp1_apbs_read(void *opaque, hwaddr a, unsigned size)
{
    Pi5Pcie *p = opaque;
    unsigned off = a & 0x3ff;
    return off >= 8 && off < 264 ? p->config[(off - 8) / 4] : 0;
}

static void rp1_apbs_write(void *opaque, hwaddr a, uint64_t val, unsigned size)
{
    Pi5Pcie *p = opaque;
    unsigned off = a & 0x3ff;
    if (off < 8 || off >= 264) {
        return;
    }
    unsigned n = (off - 8) / 4;
    if (a >= 0xc00) {
        p->config[n] &= ~val;
    } else {
        p->config[n] = a >= 0x800 ? p->config[n] | val : val;
        if (val & 4) {
            p->waiting[n] = false;
        }
        if (p->asserted[n] || (val & 2)) {
            rp1_notify(p, n);
        }
    }
}

static const MemoryRegionOps rp1_apbs_ops = {
    .read = rp1_apbs_read, .write = rp1_apbs_write, .endianness = DEVICE_LITTLE_ENDIAN,
};

static void rp1_map_bars(Pi5Pcie *p)
{
    MemoryRegion *bars[] = {&p->table, &p->bar1, &p->sram};
    for (unsigned i = 0; i < 3; ++i) {
        uint32_t addr = p->endpoint[4 + i];
        bool enable = (p->endpoint[1] & 2) &&
                      addr <= UINT32_MAX - memory_region_size(bars[i]);
        memory_region_set_enabled(bars[i], false);
        if (enable) {
            memory_region_set_address(bars[i], 0x1f00000000ULL + addr);
            memory_region_set_enabled(bars[i], true);
        }
    }
}

static void pi5_pcie_reset(Pi5Pcie *p)
{
    memset(p->regs, 0, sizeof(p->regs));
    memset(p->endpoint, 0, sizeof(p->endpoint));
    memset(p->phy, 0, sizeof(p->phy));
    memset(p->vector, 0, sizeof(p->vector));
    memset(p->config, 0, sizeof(p->config));
    memset(p->asserted, 0, sizeof(p->asserted));
    memset(p->waiting, 0, sizeof(p->waiting));
    p->pending = 0;
    p->regs[0xbc / 4] = 0x420000; /* Gen2 x4 */
    p->regs[0] = 0x271214e4;
    p->regs[8 / 4] = 0x06040021;
    p->regs[0xc / 4] = 1 << 16; /* type 1 PCI bridge */
    p->regs[0x406c / 4] = 0x0303;
    p->endpoint[0] = 0x00011de4;
    p->endpoint[1] = 1u << 20;
    p->endpoint[0x34 / 4] = 0x50;
    p->endpoint[0x50 / 4] = (63 << 16) | 0x11;
    p->endpoint[0x58 / 4] = 0x1000;
    rp1_map_bars(p);
    p->endpoint[2] = 0x02000002;
}

static uint64_t pi5_reset_read(void *opaque, hwaddr addr, unsigned size)
{
    Pi5Pcie *p = opaque;
    return addr % 0x18 == 8 ? p->reset_status[addr / 0x18] : 0;
}

static void pi5_reset_write(void *opaque, hwaddr addr, uint64_t value, unsigned size)
{
    Pi5Pcie *p = opaque;
    unsigned bank = addr / 0x18;
    if (addr % 0x18 == 0) {
        if (bank == 1 && (value & BIT(12))) {
            pi5_pcie_reset(p);
        }
        p->reset_status[bank] |= value;
    } else if (addr % 0x18 == 4) {
        p->reset_status[bank] &= ~value;
    }
}

static const MemoryRegionOps pi5_reset_ops = {
    .read = pi5_reset_read, .write = pi5_reset_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid = {.min_access_size = 4, .max_access_size = 4},
};

static uint64_t pi5_rescal_read(void *opaque, hwaddr addr, unsigned size)
{
    Pi5Pcie *p = opaque;
    return (addr == 0 || addr == 8) ? p->calibration : 0;
}

static void pi5_rescal_write(void *opaque, hwaddr addr, uint64_t value, unsigned size)
{
    Pi5Pcie *p = opaque;
    if (addr == 0) {
        p->calibration = value & 1;
    }
}

static const MemoryRegionOps pi5_rescal_ops = {
    .read = pi5_rescal_read, .write = pi5_rescal_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid = {.min_access_size = 4, .max_access_size = 4},
};

static uint64_t pi5_pcie_read(void *opaque, hwaddr addr, unsigned size)
{
    Pi5Pcie *p = opaque;
    unsigned off = addr & ~3u;
    uint32_t word = p->regs[off / 4];
    if (off == 0x4068) {
        word = 0x40 | ((p->regs[0x4064 / 4] & 4) ? 0x30 : 0);
    } else if (off == 0x1108) {
        word = 0x80000000 | p->phy[p->regs[0x1100 / 4] & 31];
    } else if (off >= 0x8000 && off < 0x9000) {
        word = p->regs[0x9000 / 4] == 1u << 20 ?
               p->endpoint[(off - 0x8000) / 4] : UINT32_MAX;
    }
    return word >> ((addr & 3) * 8);
}

static void pi5_pcie_write(void *opaque, hwaddr addr, uint64_t value, unsigned size)
{
    Pi5Pcie *p = opaque;
    unsigned off = addr & ~3u, shift = (addr & 3) * 8;
    uint32_t mask = MAKE_64BIT_MASK(shift, size * 8);
    uint32_t *word = &p->regs[off / 4];
    if (off >= 0x8000 && off < 0x9000) {
        if (p->regs[0x9000 / 4] != 1u << 20) {
            return;
        }
        unsigned reg = off - 0x8000;
        word = &p->endpoint[reg / 4];
        if (reg >= 0x10 && reg <= 0x24) {
            static const uint32_t bar_mask[] = {0xffffc000, 0xffc00000, 0xffff0000, 0, 0, 0};
            value &= bar_mask[(reg - 0x10) / 4] >> shift;
        } else if (reg == 0x50) {
            mask &= 0xc0000000;
        } else if (reg == 4) {
            mask &= 0xffff;
        } else if (reg != 4 && reg != 0x3c) {
            return;
        }
    } else if (off == 0x1104) {
        p->phy[p->regs[0x1100 / 4] & 31] = value;
        value &= 0x7fffffff;
    } else if (off == 0 || off == 8 || off == 0xc || off == 0x10 || off == 0x14 || off == 0x38) {
        return;
    }
    *word = (*word & ~mask) | ((value << shift) & mask);
    if (off == 0x8050 && p->pending) {
        for (unsigned n = 0; n < ARRAY_SIZE(p->vector); n++) {
            if (p->pending & (UINT64_C(1) << n)) {
                rp1_notify(p, n);
            }
        }
    }
    if (off >= 0x8000 && off < 0x8028) {
        rp1_map_bars(p);
    }
}

static const MemoryRegionOps pi5_pcie_ops = {
    .read = pi5_pcie_read, .write = pi5_pcie_write, .endianness = DEVICE_LITTLE_ENDIAN,
    .valid = {.min_access_size = 1, .max_access_size = 4},
};
#endif
