/* SPDX-License-Identifier: GPL-2.0-or-later */
/* BCM2712 Arm-side boot and peripherals for the OSI factory device tree. */
#include "qemu/osdep.h"
#include <libfdt.h>
#include "system/device_tree.h"
#include "qapi/error.h"
#include "qemu/error-report.h"
#include "qemu/units.h"
#include "qemu/host-utils.h"
#include "hw/arm/boot.h"
#include "hw/boards.h"
#include "hw/loader.h"
#include "hw/char/pl011.h"
#include "hw/intc/arm_gic.h"
#include "hw/net/cadence_gem.h"
#include "hw/usb/hcd-dwc3.h"
#include "hw/qdev-properties.h"
#include "hw/sd/sdhci.h"
#include "hw/timer/bcm2835_systmr.h"
#include "hw/ssi/bcm2835_spi.h"
#include "hw/sd/sd.h"
#include "system/address-spaces.h"
#include "system/blockdev.h"
#include "system/system.h"
#include "system/reset.h"
#include "target/arm/cpu.h"
#include "target/arm/cpregs.h"
#include "target/arm/gtimer.h"

#include "wm1302-spi.h"
#include "rp1-gpio.h"
#include "rp1-fan.h"
#include "hat-gnss.h"
#include "bcm2712-pcie.h"
#include "bcm2712-rng.h"
#include "bcm2712-watchdog.h"
#include "wm1302-i2c.h"

#define TYPE_PI5 MACHINE_TYPE_NAME("raspi5b")
OBJECT_DECLARE_SIMPLE_TYPE(Pi5State, PI5)
struct Pi5State {
    MachineState parent;
    char *bootconf_file;
    size_t bootconf_size;
    struct arm_boot_info boot;
    WmSpiState spi;
    Rp1Gpio gpio;
    WmI2c i2c;
    Pi5Fan fan;
    HatGnss gnss;
    Pi5Pcie pcie;
    Pi5Rng rng;
    Pi5Watchdog watchdog;
    MemoryRegion rp1_io;
    MemoryRegion usb_device_regs[2];
    MemoryRegion boot_gpio;
    qemu_irq eeprom_cs;
    uint32_t boot_gpio_regs[16];
    MemoryRegion local_control, wifi_cfg, sd_cfg, sd_busisol, sd_lcpll;
};

enum { CORES = 4, SPIS = 288 };

/* Report only populated devices to the kernel. Keep the shipped DTB on SD. */
static void pi5_modify_dtb(const struct arm_boot_info *info, void *fdt)
{
    Pi5State *s = PI5(qdev_get_machine());
    if (s->bootconf_size) {
        const char *node = "/reserved-memory/nvram@0";
        qemu_fdt_setprop_cells(fdt, node, "reg", 0, 0x38000, s->bootconf_size);
        qemu_fdt_setprop_string(fdt, node, "status", "okay");
    }
    const char *buses[] = { "/axi", "/soc" };
    const char *sd = "/axi/mmc@fff000";
    const char *unused[] = {
        "pinctrl-0", "pinctrl-names", "cd-gpios", "vmmc-supply", "vqmmc-supply",
        "supports-cqe", "sd-uhs-sdr50", "sd-uhs-ddr50", "sd-uhs-sdr104",
    };
    /* The shipped DT uses one size cell. Describe high RAM in 1 GiB banks. */
    uint64_t total = MACHINE(qdev_get_machine())->ram_size;
    /* Pi 5 PCB revision 1.1 exists in all five memory sizes. */
    uint32_t board_revision = 0xa04171 + (ctz64(total / GiB) << 20);
    if (fdt_path_offset(fdt, "/system") < 0) {
        qemu_fdt_add_subnode(fdt, "/system");
    }
    qemu_fdt_setprop_cell(fdt, "/system", "linux,revision", board_revision);
    qemu_fdt_setprop_cells(fdt, "/system", "linux,serial", 0, 1);
    qemu_fdt_setprop_string(fdt, "/", "serial-number", "0000000000000001");
    for (uint64_t base = info->ram_size; base < total; base += GiB) {
        g_autofree char *name = g_strdup_printf("/memory@%" PRIx64, base);
        qemu_fdt_add_subnode(fdt, name);
        qemu_fdt_setprop_string(fdt, name, "device_type", "memory");
        qemu_fdt_setprop_cells(fdt, name, "reg", base >> 32, (uint32_t)base, GiB);
    }
    for (int i = 0; i < ARRAY_SIZE(buses); i++) {
        int parent = fdt_path_offset(fdt, buses[i]);
        int child;
        /* Work backwards so growing a node cannot invalidate earlier offsets. */
        g_autoptr(GArray) offsets = g_array_new(false, false, sizeof(int));
        fdt_for_each_subnode(child, fdt, parent) {
            const char *name = fdt_get_name(fdt, child, NULL);
            if (s->eeprom_cs && (!strcmp(name, "gpio@7d508500") || !strcmp(name, "spi@7d004000"))) {
                continue;
            }
            if (strcmp(name, "timer@7c003000") && strcmp(name, "watchdog@7d200000") && strcmp(name, "rng@7d208000") && strcmp(name, "reset-controller@1504318") &&
                strcmp(name, "reset-controller@119500") && strcmp(name, "msi-controller@130000") && strcmp(name, "pcie@120000") && strcmp(name, "mmc@1100000") && strcmp(name, "mmc@fff000") && strcmp(name, "serial@7d001000") &&
                strcmp(name, "interrupt-controller@7fff9000") && strcmp(name, "avs-monitor@7d542000")) {
                g_array_append_val(offsets, child);
            }
        }
        for (int n = (int)offsets->len - 1; n >= 0; n--) {
            if (fdt_setprop_string(fdt, g_array_index(offsets, int, n),
                                   "status", "disabled") < 0) {
                error_report("raspi5b: cannot describe peripheral availability");
                exit(1);
            }
        }
    }
    if (s->eeprom_cs) {
        const char *spi10 = "/soc/spi@7d004000", *gpio1 = "/soc/gpio@7d508500";
        const char *dma_pins[] = {"dmas", "dma-names", "pinctrl-names", "pinctrl-0"};
        const char *irq_props[] = {"interrupt-controller", "#interrupt-cells", "interrupt-parent", "interrupts"};
        for (size_t i = 0; i < ARRAY_SIZE(dma_pins); i++) {
            fdt_delprop(fdt, fdt_path_offset(fdt, spi10), dma_pins[i]);
        }
        for (size_t i = 0; i < ARRAY_SIZE(irq_props); i++) {
            fdt_delprop(fdt, fdt_path_offset(fdt, gpio1), irq_props[i]);
        }
    }
    for (int i = 0; i < ARRAY_SIZE(unused); i++) {
        fdt_delprop(fdt, fdt_path_offset(fdt, sd), unused[i]);
    }
    qemu_fdt_setprop(fdt, sd, "pinctrl-0", NULL, 0);
    qemu_fdt_setprop_string(fdt, sd, "pinctrl-names", "default");
    qemu_fdt_setprop(fdt, sd, "non-removable", NULL, 0);
    qemu_fdt_setprop(fdt, sd, "no-1-8-v", NULL, 0);
    const char *wifi = "/axi/mmc@1100000";
    for (int i = 0; i < ARRAY_SIZE(unused); i++) {
        fdt_delprop(fdt, fdt_path_offset(fdt, wifi), unused[i]);
    }
    qemu_fdt_setprop(fdt, wifi, "pinctrl-0", NULL, 0);
    qemu_fdt_setprop_string(fdt, wifi, "pinctrl-names", "default");
    qemu_fdt_setprop(fdt, wifi, "no-1-8-v", NULL, 0);
    /* Preserve the factory config.txt result for the two HAT buses. */
    int spi_node = fdt_path_offset(fdt, "/axi/pcie@120000/rp1/spi@50000");
    int i2c_node = fdt_path_offset(fdt, "/axi/pcie@120000/rp1/i2c@74000");
    const char *spi_status = fdt_getprop(fdt, spi_node, "status", NULL);
    const char *i2c_status = fdt_getprop(fdt, i2c_node, "status", NULL);
    bool spi_enabled = spi_node >= 0 && (!spi_status || strcmp(spi_status, "disabled") != 0);
    bool i2c_enabled = i2c_node >= 0 && (!i2c_status || strcmp(i2c_status, "disabled") != 0);
    uint32_t rp1_id = fdt_get_phandle(fdt, fdt_path_offset(fdt, "/axi/pcie@120000/rp1"));
    /* Keep the firmware's RP1 bus and windows; describe implemented children.
     * DMA-capable QEMU devices use guest physical addresses on the RP1 side. */
    const char *rp1 = "/axi/pcie@120000/rp1";
    uint32_t gpio_id = fdt_get_phandle(fdt, fdt_path_offset(fdt, "/axi/pcie@120000/rp1/gpio@d0000"));
    int parent = fdt_path_offset(fdt, rp1), child;
    while ((child = fdt_first_subnode(fdt, parent)) >= 0) {
        fdt_del_node(fdt, child);
    }
    qemu_fdt_setprop_cells(fdt, rp1, "dma-ranges", 0, 0, 0x43000000, 0x10, 0, 0x10, 0);
    const char *gpio = "/axi/pcie@120000/rp1/gpio@d0000";
    qemu_fdt_add_subnode(fdt, gpio);
    qemu_fdt_setprop_string(fdt, gpio, "compatible", "raspberrypi,rp1-gpio");
    qemu_fdt_setprop_cells(fdt, gpio, "reg", 0xc0, 0x40000000 + 0xd0000, 0, 0xc000,
                           0xc0, 0x40000000 + 0xe0000, 0, 0xc000, 0xc0, 0x40000000 + 0xf0000, 0, 0xc000);
    qemu_fdt_setprop_cell(fdt, gpio, "interrupt-parent", rp1_id);
    qemu_fdt_setprop_cells(fdt, gpio, "interrupts", 0, 4, 1, 4, 2, 4);
    qemu_fdt_setprop(fdt, gpio, "gpio-controller", NULL, 0);
    qemu_fdt_setprop_cell(fdt, gpio, "#gpio-cells", 2);
    qemu_fdt_setprop_cell(fdt, gpio, "phandle", gpio_id);
    qemu_fdt_setprop_cells(fdt, gpio, "gpio-ranges", gpio_id, 0, 0, 54);
    qemu_fdt_setprop_string(fdt, "/aliases", "gpio0", gpio);
    qemu_fdt_setprop_string(fdt, "/aliases", "gpiochip0", gpio);
    const char *spi = "/axi/pcie@120000/rp1/spi@50000";
    const char *clock = "/spi0-clock";
    const char *chip = "/axi/pcie@120000/rp1/spi@50000/spidev@0";
    uint32_t clk_id = qemu_fdt_alloc_phandle(fdt);
    qemu_fdt_add_subnode(fdt, clock);
    qemu_fdt_setprop_string(fdt, clock, "compatible", "fixed-clock");
    qemu_fdt_setprop_cell(fdt, clock, "#clock-cells", 0);
    qemu_fdt_setprop_cell(fdt, clock, "clock-frequency", 200000000);
    qemu_fdt_setprop_cell(fdt, clock, "phandle", clk_id);
    for (int i = 0; i < 2; i++) {
        unsigned offset = (2 + i) * 0x100000;
        g_autofree char *usb = g_strdup_printf("/axi/pcie@120000/rp1/usb@%x", offset);
        qemu_fdt_add_subnode(fdt, usb);
        qemu_fdt_setprop_string(fdt, usb, "compatible", "snps,dwc3");
        qemu_fdt_setprop_string(fdt, usb, "dr_mode", "host");
        qemu_fdt_setprop_cells(fdt, usb, "reg", 0xc0, 0x40000000 + offset, 0, 0x100000);
        qemu_fdt_setprop_cell(fdt, usb, "interrupt-parent", rp1_id);
    qemu_fdt_setprop_cells(fdt, usb, "interrupts", 31 + 5 * i, 4);
    }
    const char *pwm = "/axi/pcie@120000/rp1/pwm@9c000";
    const char *pwm_clk = "/pwm-clock";
    uint32_t pwm_clk_id = qemu_fdt_alloc_phandle(fdt);
    qemu_fdt_add_subnode(fdt, pwm_clk);
    qemu_fdt_setprop_string(fdt, pwm_clk, "compatible", "fixed-clock");
    qemu_fdt_setprop_cell(fdt, pwm_clk, "#clock-cells", 0);
    qemu_fdt_setprop_cell(fdt, pwm_clk, "clock-frequency", 50000000);
    qemu_fdt_setprop_cell(fdt, pwm_clk, "phandle", pwm_clk_id);
    uint32_t pwm_id = qemu_fdt_alloc_phandle(fdt);
    qemu_fdt_add_subnode(fdt, pwm);
    qemu_fdt_setprop_string(fdt, pwm, "compatible", "raspberrypi,rp1-pwm");
    qemu_fdt_setprop_cells(fdt, pwm, "reg", 0xc0, 0x40000000 + 0x9c000, 0, 0x100);
    qemu_fdt_setprop_cell(fdt, pwm, "#pwm-cells", 3);
    qemu_fdt_setprop_cell(fdt, pwm, "clocks", pwm_clk_id);
    qemu_fdt_setprop_cell(fdt, pwm, "phandle", pwm_id);
    qemu_fdt_setprop_cells(fdt, "/cooling_fan", "pwms", pwm_id, 3, 41566, 1);
    qemu_fdt_setprop_cell(fdt, "/cooling_fan", "rpm-regmap", pwm_id);
    const char *eth = "/axi/pcie@120000/rp1/ethernet@100000";
    const char *phy = "/axi/pcie@120000/rp1/ethernet@100000/ethernet-phy@1";
    const char clock_names[] = "pclk\0hclk\0tsu_clk\0tx_clk";
    uint32_t phy_id = qemu_fdt_alloc_phandle(fdt);
    qemu_fdt_add_subnode(fdt, eth);
    qemu_fdt_setprop_string(fdt, eth, "compatible", "cdns,gem");
    qemu_fdt_setprop_cells(fdt, eth, "reg", 0xc0, 0x40000000 + 0x100000, 0, 0x4000);
    qemu_fdt_setprop_cell(fdt, eth, "interrupt-parent", rp1_id);
    qemu_fdt_setprop_cells(fdt, eth, "interrupts", 6, 4);
    const char *tx_clock = "/gem-tx-clock";
    uint32_t tx_id = qemu_fdt_alloc_phandle(fdt);
    qemu_fdt_add_subnode(fdt, tx_clock);
    qemu_fdt_setprop_string(fdt, tx_clock, "compatible", "fixed-clock");
    qemu_fdt_setprop_cell(fdt, tx_clock, "#clock-cells", 0);
    qemu_fdt_setprop_cell(fdt, tx_clock, "clock-frequency", 125000000);
    qemu_fdt_setprop_cell(fdt, tx_clock, "phandle", tx_id);
    qemu_fdt_setprop_cells(fdt, eth, "clocks", clk_id, clk_id, clk_id, tx_id);
    qemu_fdt_setprop(fdt, eth, "clock-names", clock_names, sizeof(clock_names));
    qemu_fdt_setprop_string(fdt, eth, "phy-mode", "rgmii-id");
    qemu_fdt_setprop_cell(fdt, eth, "#address-cells", 1);
    qemu_fdt_setprop_cell(fdt, eth, "#size-cells", 0);
    qemu_fdt_setprop_cell(fdt, eth, "phy-handle", phy_id);
    qemu_fdt_add_subnode(fdt, phy);
    qemu_fdt_setprop_cell(fdt, phy, "reg", 1);
    qemu_fdt_setprop_cell(fdt, phy, "phandle", phy_id);
    qemu_fdt_setprop_string(fdt, "/aliases", "ethernet0", eth);
    const char *uart = "/axi/pcie@120000/rp1/serial@30000";
    const char uart_clocks[] = "uartclk\0apb_pclk";
    uint32_t uart_clk_id = qemu_fdt_alloc_phandle(fdt);
    qemu_fdt_add_subnode(fdt, "/uart0-clock");
    qemu_fdt_setprop_string(fdt, "/uart0-clock", "compatible", "fixed-clock");
    qemu_fdt_setprop_cell(fdt, "/uart0-clock", "#clock-cells", 0);
    qemu_fdt_setprop_cell(fdt, "/uart0-clock", "clock-frequency", 50000000);
    qemu_fdt_setprop_cell(fdt, "/uart0-clock", "phandle", uart_clk_id);
    qemu_fdt_add_subnode(fdt, uart);
    qemu_fdt_setprop_string(fdt, uart, "compatible", "arm,pl011-axi");
    qemu_fdt_setprop_cell(fdt, uart, "arm,primecell-periphid", 0x341011);
    qemu_fdt_setprop_cells(fdt, uart, "reg", 0xc0, 0x40000000 + 0x30000, 0, 0x1000);
    qemu_fdt_setprop_cell(fdt, uart, "interrupt-parent", rp1_id);
    qemu_fdt_setprop_cells(fdt, uart, "interrupts", 25, 4);
    qemu_fdt_setprop_cells(fdt, uart, "clocks", uart_clk_id, clk_id);
    qemu_fdt_setprop(fdt, uart, "clock-names", uart_clocks, sizeof(uart_clocks));
    qemu_fdt_setprop_string(fdt, "/aliases", "serial0", uart);
    const char *i2c = "/axi/pcie@120000/rp1/i2c@74000";
    qemu_fdt_add_subnode(fdt, i2c);
    qemu_fdt_setprop_string(fdt, i2c, "status", i2c_enabled ? "okay" : "disabled");
    qemu_fdt_setprop_string(fdt, i2c, "compatible", "snps,designware-i2c");
    qemu_fdt_setprop_cells(fdt, i2c, "reg", 0xc0, 0x40000000 + 0x74000, 0, 0x1000);
    qemu_fdt_setprop_cell(fdt, i2c, "interrupt-parent", rp1_id);
    qemu_fdt_setprop_cells(fdt, i2c, "interrupts", 8, 4);
    qemu_fdt_setprop_cell(fdt, i2c, "clocks", clk_id);
    qemu_fdt_setprop_cell(fdt, i2c, "clock-frequency", 100000);
    qemu_fdt_setprop_string(fdt, "/aliases", "i2c1", i2c);
    qemu_fdt_add_subnode(fdt, spi);
    qemu_fdt_setprop_string(fdt, spi, "status", spi_enabled ? "okay" : "disabled");
    qemu_fdt_setprop_string(fdt, spi, "compatible", "snps,dw-apb-ssi");
    qemu_fdt_setprop_cells(fdt, spi, "reg", 0xc0, 0x40000000 + 0x50000, 0, 0x130);
    qemu_fdt_setprop_cell(fdt, spi, "interrupt-parent", rp1_id);
    qemu_fdt_setprop_cells(fdt, spi, "interrupts", 19, 4);
    qemu_fdt_setprop_cell(fdt, spi, "clocks", clk_id);
    qemu_fdt_setprop_string(fdt, spi, "clock-names", "ssi_clk");
    qemu_fdt_setprop_cell(fdt, spi, "#address-cells", 1);
    qemu_fdt_setprop_cell(fdt, spi, "#size-cells", 0);
    qemu_fdt_setprop_string(fdt, "/aliases", "spi0", spi);
    qemu_fdt_add_subnode(fdt, chip);
    qemu_fdt_setprop_string(fdt, chip, "compatible", "spidev");
    qemu_fdt_setprop_cell(fdt, chip, "reg", 0);
    qemu_fdt_setprop_cell(fdt, chip, "spi-max-frequency", 8000000);

}

/* The host-only DWC3 still exposes DCTL. Core reset self-clears. */
static uint64_t usb_device_read(void *opaque, hwaddr offset, unsigned size)
{
    return 0;
}

static void usb_device_write(void *opaque, hwaddr offset, uint64_t value, unsigned size)
{
}

static const MemoryRegionOps usb_device_ops = {
    .read = usb_device_read, .write = usb_device_write, .endianness = DEVICE_LITTLE_ENDIAN,
};

static void pi5_reset(void *opaque)
{
    Pi5State *s = opaque;
    WmSpiState *spi = &s->spi;
    memset(s->pcie.reset_status, 0, sizeof(s->pcie.reset_status));
    if (s->eeprom_cs) {
        memset(s->boot_gpio_regs, 0, sizeof(s->boot_gpio_regs));
        s->boot_gpio_regs[2] = s->boot_gpio_regs[10] = UINT32_MAX;
        qemu_set_irq(s->eeprom_cs, 1);
    }
    timer_del(s->watchdog.timer);
    s->watchdog.ticks = 0;
    s->watchdog.rstc = 0x102;
    memset(s->rng.reg, 0, sizeof(s->rng.reg));
    pi5_rng_update(&s->rng, qemu_clock_get_us(QEMU_CLOCK_VIRTUAL));
    s->pcie.calibration = 0;
    pi5_pcie_reset(&s->pcie);
    wm_chip_reset(spi);
    spi->enabled = spi->write = false;
    spi->active = true;
    spi->reset_us = qemu_clock_get_us(QEMU_CLOCK_VIRTUAL);
    spi->head = spi->count = spi->remaining = spi->ndf = 0;
    spi->ctrl = spi->divisor = spi->selected = spi->mask = 0;
    spi->tx_threshold = spi->rx_threshold = 0;
    wm_spi_irq(spi);
    memset(s->gpio.regs, 0, sizeof(s->gpio.regs));
    memset(s->fan.regs, 0, sizeof(s->fan.regs));
    memset(s->i2c.regs, 0, sizeof(s->i2c.regs));
    memset(&s->i2c.atecc, 0, sizeof(s->i2c.atecc));
    memset(s->i2c.sensor, 0, sizeof(s->i2c.sensor));
    s->i2c.sensor[0] = 25;
    s->i2c.sensor[0xfe] = 0x53;
    s->i2c.pending = s->i2c.count = s->i2c.head = s->i2c.pointer = 0;
    s->i2c.addressed = false;
    wm_i2c_irq(&s->i2c);
    s->gnss.second = -1;
    timer_mod(s->gnss.timer, qemu_clock_get_us(QEMU_CLOCK_VIRTUAL));
}

/* TCG models no cache timing or speculative execution controls. */
static void pi5_cpu_controls(ARMCPU *cpu)
{
    static const struct { const char *name; unsigned crm, op2; } fields[] = {
        {"CPUACTLR_EL1", 1, 0}, {"CPUACTLR2_EL1", 1, 1},
        {"CPUACTLR3_EL1", 1, 2}, {"CPUECTLR_EL1", 1, 4},
        {"CLUSTERECTLR_EL1", 3, 4}, {"CPUPWRCTLR_EL1", 2, 7},
        {"CLUSTERPWRCTLR_EL1", 3, 5},
    };
    const char *prefetch[] = {"CPUPSELR_EL3", "CPUPCR_EL3", "CPUPOR_EL3", "CPUPMR_EL3"};
    for (unsigned i = 0; i < ARRAY_SIZE(prefetch); i++) {
        ARMCPRegInfo reg = {
            .name = prefetch[i], .state = ARM_CP_STATE_AA64, .opc0 = 3, .opc1 = 6,
            .crn = 15, .crm = 8, .opc2 = i, .access = PL3_RW, .type = ARM_CP_CONST,
        };
        define_one_arm_cp_reg(cpu, &reg);
    }
    for (unsigned i = 0; i < ARRAY_SIZE(fields); i++) {
        ARMCPRegInfo reg = {
            .name = fields[i].name, .state = ARM_CP_STATE_AA64,
            .opc0 = 3, .opc1 = 0, .crn = 15, .crm = fields[i].crm,
            .opc2 = fields[i].op2, .access = PL1_RW, .type = ARM_CP_CONST,
        };
        define_one_arm_cp_reg(cpu, &reg);
    }
}

static void pi5_load_armstub(Pi5State *s, MachineState *ms, ARMCPU *cpu)
{
    const hwaddr dtb_addr = 0x8000000;
    g_autofree uint8_t *stub = g_malloc(MiB);
    ssize_t stub_size = load_image_size(ms->firmware, stub, MiB);
    if (stub_size < 0x1000 || stub_size > (s->bootconf_size ? 0x38000 : 0x80000) || ldl_le_p(stub + 0xf0) != 0x5afe570b) {
        error_report("raspi5b: expected BCM2712 armstub8 header in -bios file");
        exit(1);
    }
    g_autofree uint8_t *image = NULL;
    ssize_t size = load_image_gzipped_buffer(ms->kernel_filename, dtb_addr, &image);
    if (size < 0) {
        gsize raw_size;
        if (!g_file_get_contents(ms->kernel_filename, (char **)&image, &raw_size, NULL)) {
            error_report("raspi5b: cannot read the selected kernel");
            exit(1);
        }
        size = raw_size;
    }
    if (size < 64 || memcmp(image + 56, "ARM\x64", 4)) {
        error_report("raspi5b: expected an AArch64 Linux Image");
        exit(1);
    }
    uint64_t image_size = ldq_le_p(image + 16);
    hwaddr offset = image_size ? ldq_le_p(image + 8) : 0x80000;
    if (offset >= dtb_addr - 2 * MiB ||
        MAX(image_size, (uint64_t)size) > dtb_addr - 2 * MiB - offset) {
        error_report("raspi5b: kernel overlaps the DTB");
        exit(1);
    }
    hwaddr entry = 2 * MiB + offset;
    /* VideoCore writes the two addresses here before releasing the A76s. */
    stl_le_p(stub + 0xf0, 0);
    stl_le_p(stub + 0xf8, dtb_addr);
    stl_le_p(stub + 0xfc, entry);
    rom_add_blob_fixed("BCM2712 armstub", stub, stub_size, 0);
    rom_add_blob_fixed("factory kernel", image, size, entry);
    s->boot.dtb_filename = ms->dtb;
    s->boot.kernel_cmdline = ms->kernel_cmdline;
    if (arm_load_dtb(dtb_addr, &s->boot, GiB, &address_space_memory, ms, cpu) <= 0) {
        error_report("raspi5b: could not prepare EL3 device tree");
        exit(1);
    }
}

static uint64_t pi5_boot_gpio_read(void *opaque, hwaddr addr, unsigned size)
{
    return ((Pi5State *)opaque)->boot_gpio_regs[addr / 4];
}

static void pi5_boot_gpio_write(void *opaque, hwaddr addr, uint64_t val, unsigned size)
{
    Pi5State *s = opaque;
    s->boot_gpio_regs[addr / 4] = val;
    /* GPIO1 is BOOT_CS_N. Input direction releases the line high. */
    if (addr == 4 || addr == 8) {
        qemu_set_irq(s->eeprom_cs, !!((s->boot_gpio_regs[1] | s->boot_gpio_regs[2]) & 2));
    }
}

static const MemoryRegionOps pi5_boot_gpio_ops = {
    .read = pi5_boot_gpio_read, .write = pi5_boot_gpio_write,
    .endianness = DEVICE_LITTLE_ENDIAN,
    .valid = {.min_access_size = 4, .max_access_size = 4},
};

static void pi5_boot_flash(Pi5State *s, DriveInfo *image, DeviceState *gic)
{
    DeviceState *host = qdev_new(TYPE_BCM2835_SPI);
    DeviceState *flash = qdev_new("mx25l1606e");
    sysbus_realize_and_unref(SYS_BUS_DEVICE(host), &error_fatal);
    sysbus_mmio_map(SYS_BUS_DEVICE(host), 0, 0x107d004000);
    sysbus_connect_irq(SYS_BUS_DEVICE(host), 0, qdev_get_gpio_in(gic, 118));
    qdev_prop_set_drive_err(flash, "drive", blk_by_legacy_dinfo(image), &error_fatal);
    qdev_realize_and_unref(flash, qdev_get_child_bus(host, "spi"), &error_fatal);
    s->eeprom_cs = qdev_get_gpio_in_named(flash, SSI_GPIO_CS, 0);
    memory_region_init_io(&s->boot_gpio, OBJECT(s), &pi5_boot_gpio_ops, s,
                          "bcm2712.boot-gpio", sizeof(s->boot_gpio_regs));
    memory_region_add_subregion(get_system_memory(), 0x107d508500, &s->boot_gpio);
}

static void pi5_arm_reset(void *opaque)
{
    cpu_reset(CPU(opaque));
}

static void pi5_init(MachineState *ms)
{
    Pi5State *s = PI5(ms);
    DeviceState *cpu[CORES];
    DeviceState *gic = qdev_new(TYPE_ARM_GIC);
    DeviceState *host = qdev_new(TYPE_SYSBUS_SDHCI);
    DriveInfo *sd = drive_get(IF_SD, 0, 0);

    if (!ms->kernel_filename || !ms->dtb || ms->ram_size < GiB ||
        ms->ram_size > 16 * GiB || !is_power_of_2(ms->ram_size)) {
        error_report("raspi5b requires -kernel and -dtb from the image and 1, 2, 4, 8 or 16 GiB RAM");
        exit(1);
    }
    memory_region_add_subregion(get_system_memory(), 0, ms->ram);
    if (s->bootconf_file) {
        ssize_t size = load_image_targphys(s->bootconf_file, 0x38000, 4096);
        if (size <= 0) {
            error_report("raspi5b: invalid EEPROM configuration file");
            exit(1);
        }
        s->bootconf_size = size;
    }
    for (int i = 0; i < CORES; i++) {
        cpu[i] = qdev_new(ARM_CPU_TYPE_NAME("cortex-a76"));
        qdev_prop_set_uint64(cpu[i], "mp-affinity", i << 8);
        qdev_prop_set_uint64(cpu[i], "cntfrq", 54000000);
        if (ms->firmware) {
            pi5_cpu_controls(ARM_CPU(cpu[i]));
        }
        qdev_realize(cpu[i], NULL, &error_fatal);
        if (ms->firmware) {
            qemu_register_reset(pi5_arm_reset, cpu[i]);
        }
    }

    qdev_prop_set_uint32(gic, "revision", 2);
    qdev_prop_set_uint32(gic, "num-cpu", CORES);
    qdev_prop_set_uint32(gic, "num-irq", SPIS + 32);
    qdev_prop_set_bit(gic, "has-security-extensions", ms->firmware != NULL);
    qdev_prop_set_bit(gic, "has-virtualization-extensions", true);
    sysbus_realize_and_unref(SYS_BUS_DEVICE(gic), &error_fatal);
    sysbus_mmio_map(SYS_BUS_DEVICE(gic), 0, 0x107fff9000);
    sysbus_mmio_map(SYS_BUS_DEVICE(gic), 1, 0x107fffa000);
    sysbus_mmio_map(SYS_BUS_DEVICE(gic), 2, 0x107fffc000);
    sysbus_mmio_map(SYS_BUS_DEVICE(gic), 3, 0x107fffe000);
    for (int i = 0; i < CORES; i++) {
        int ppi = SPIS + 32 * i;
        const int outputs[] = { ARM_CPU_IRQ, ARM_CPU_FIQ, ARM_CPU_VIRQ, ARM_CPU_VFIQ };
        for (int j = 0; j < ARRAY_SIZE(outputs); j++) {
            sysbus_connect_irq(SYS_BUS_DEVICE(gic), i + j * CORES,
                               qdev_get_gpio_in(cpu[i], outputs[j]));
        }
        sysbus_connect_irq(SYS_BUS_DEVICE(gic), i + 4 * CORES, qdev_get_gpio_in(gic, ppi + 25));
        qdev_connect_gpio_out(cpu[i], GTIMER_PHYS, qdev_get_gpio_in(gic, ppi + 30));
        qdev_connect_gpio_out(cpu[i], GTIMER_VIRT, qdev_get_gpio_in(gic, ppi + 27));
        qdev_connect_gpio_out(cpu[i], GTIMER_HYP, qdev_get_gpio_in(gic, ppi + 26));
        qdev_connect_gpio_out(cpu[i], GTIMER_SEC, qdev_get_gpio_in(gic, ppi + 29));
    }
    /* RP1 pinctrl orders GPIO writes through the PCIe slot control register. */
    memory_region_init_io(&s->pcie.mmio, OBJECT(s), &pi5_pcie_ops, &s->pcie,
                          "bcm2712.pcie2", sizeof(s->pcie.regs));
    memory_region_add_subregion(get_system_memory(), 0x1000120000, &s->pcie.mmio);
    memory_region_init(&s->rp1_io, OBJECT(s), "rp1.io", 0x400000);
    /* BAR1 is the CPU mapping for this downstream bus. */
    memory_region_init_io(&s->fan.pwm, OBJECT(s), &fan_ops, &s->fan, "rp1.pwm1", 0x100);
    memory_region_add_subregion(&s->rp1_io, 0x09c000, &s->fan.pwm);
    memory_region_init_io(&s->fan.avs, OBJECT(s), &avs_ops, NULL, "bcm2712.avs", 0xf00);
    memory_region_add_subregion(get_system_memory(), 0x107d542000, &s->fan.avs);
    memory_region_init_ram_nomigrate(&s->local_control, OBJECT(s), "bcm2712.local", 0x100, &error_fatal);
    memory_region_add_subregion(get_system_memory(), 0x107c280000, &s->local_control);
    s->watchdog.timer = timer_new_ns(QEMU_CLOCK_VIRTUAL, pi5_watchdog_expire, &s->watchdog);
    s->watchdog.rsts = 0x1000;
    memory_region_init_io(&s->watchdog.mmio, OBJECT(s), &pi5_watchdog_ops, &s->watchdog,
                          "bcm2712.pm", 0x308);
    memory_region_add_subregion(get_system_memory(), 0x107d200000, &s->watchdog.mmio);
    memory_region_init_io(&s->rng.mmio, OBJECT(s), &pi5_rng_ops, &s->rng,
                          "bcm2712.rng200", 0x28);
    memory_region_add_subregion(get_system_memory(), 0x107d208000, &s->rng.mmio);
    Pi5Pcie *pcie = &s->pcie;
    memory_region_init_io(&pcie->reset_bank, OBJECT(s), &pi5_reset_ops, pcie,
                          "bcm2712.reset", 0x30);
    memory_region_add_subregion(get_system_memory(), 0x1001504318, &pcie->reset_bank);
    memory_region_init_io(&pcie->rescal, OBJECT(s), &pi5_rescal_ops, pcie,
                          "bcm2712.rescal", 0x10);
    memory_region_add_subregion(get_system_memory(), 0x1000119500, &pcie->rescal);
    for (unsigned i = 0; i < 64; i++) {
        pcie->destination[i] = qdev_get_gpio_in(gic, 128 + i);
    }
    memory_region_init_ram_nomigrate(&pcie->mip, OBJECT(s), "bcm2712.mip", 0xc0, &error_fatal);
    memory_region_add_subregion(get_system_memory(), 0x1000130000, &pcie->mip);
    memory_region_init_ram_nomigrate(&pcie->sysinfo, OBJECT(s), "rp1.sysinfo", 0x1000, &error_fatal);
    stl_le_p(memory_region_get_ram_ptr(&pcie->sysinfo), 0x20001927);
    memory_region_add_subregion(&s->rp1_io, 0x000000, &pcie->sysinfo);
    memory_region_init_io(&pcie->apbs, OBJECT(s), &rp1_apbs_ops, pcie, "rp1.apbs", 0x1000);
    memory_region_add_subregion(&s->rp1_io, 0x108000, &pcie->apbs);
    memory_region_init_io(&pcie->table, OBJECT(s), &rp1_table_ops, pcie, "rp1.msix", 0x4000);
    memory_region_init_alias(&pcie->bar1, OBJECT(s), "rp1.bar1", &s->rp1_io,
                             0, 0x400000);
    memory_region_init_ram_nomigrate(&pcie->sram, OBJECT(s), "rp1.sram", 0x10000, &error_fatal);
    MemoryRegion *bars[] = {&pcie->table, &pcie->bar1, &pcie->sram};
    for (unsigned i = 0; i < ARRAY_SIZE(bars); i++) {
        memory_region_set_enabled(bars[i], false);
        memory_region_add_subregion_overlap(get_system_memory(), 0, bars[i], 1);
    }
    s->i2c.irq = qemu_allocate_irq(rp1_input, pcie, 8);
    memory_region_init_io(&s->i2c.mmio, OBJECT(s), &wm_i2c_ops, &s->i2c, "rp1.i2c1", 0x1000);
    memory_region_add_subregion(&s->rp1_io, 0x074000, &s->i2c.mmio);
    s->gpio.spi = &s->spi;
    memory_region_init_io(&s->gpio.mmio, OBJECT(s), &rp1_gpio_ops, &s->gpio,
                          "rp1.gpio", 0x2c000);
    memory_region_add_subregion(&s->rp1_io, 0x0d0000, &s->gpio.mmio);
    for (unsigned i = 0; i < 2; i++) {
        WmTx *tx = &s->spi.tx[i];
        tx->chain = i;
        tx->spi = &s->spi;
        tx->status = 0x80;
        tx->timer = timer_new_us(QEMU_CLOCK_VIRTUAL, wm_tx_event, tx);
    }
    Chardev *medium = qemu_chr_find("wm1302-air");
    if (medium) {
        qemu_chr_fe_init(&s->spi.air, medium, &error_fatal);
        qemu_chr_fe_set_handlers(&s->spi.air, wm_air_space, wm_air_read,
                                 wm_air_event, NULL, &s->spi, NULL, true);
    }
    s->spi.irq = qemu_allocate_irq(rp1_input, pcie, 19);
    memory_region_init_io(&s->spi.mmio, OBJECT(s), &wm_spi_ops, &s->spi, "rp1.spi0", 0x130);
    memory_region_add_subregion(&s->rp1_io, 0x50000, &s->spi.mmio);
    for (int i = 0; i < 2; i++) {
        DeviceState *dwc = qdev_new(TYPE_USB_DWC3);
        DeviceState *xhci = DEVICE(&USB_DWC3(dwc)->sysbus_xhci);
        object_property_set_link(OBJECT(xhci), "dma", OBJECT(get_system_memory()), &error_fatal);
        qdev_prop_set_uint32(xhci, "intrs", 1);
        qdev_prop_set_uint32(xhci, "p2", 2);
        qdev_prop_set_uint32(xhci, "p3", 1);
        sysbus_realize_and_unref(SYS_BUS_DEVICE(dwc), &error_fatal);
        memory_region_init_io(&s->usb_device_regs[i], OBJECT(s), &usb_device_ops, NULL,
                              "dwc3.device", 0xa00);
        memory_region_add_subregion(&USB_DWC3(dwc)->iomem, 0xc600, &s->usb_device_regs[i]);
        memory_region_add_subregion(&s->rp1_io, 0x200000 + 0x100000 * i, sysbus_mmio_get_region(SYS_BUS_DEVICE(dwc), 0));
        sysbus_connect_irq(SYS_BUS_DEVICE(xhci), 0, qemu_allocate_irq(rp1_input, pcie, 31 + 5 * i));
    }
    DeviceState *gem = qdev_new(TYPE_CADENCE_GEM);
    qdev_prop_set_uint8(gem, "phy-addr", 1);
    qemu_configure_nic_device(gem, true, NULL);
    sysbus_realize_and_unref(SYS_BUS_DEVICE(gem), &error_fatal);
    memory_region_add_subregion(&s->rp1_io, 0x100000, sysbus_mmio_get_region(SYS_BUS_DEVICE(gem), 0));
    sysbus_connect_irq(SYS_BUS_DEVICE(gem), 0, qemu_allocate_irq(rp1_input, pcie, 6));
    DriveInfo *eeprom = drive_get(IF_MTD, 0, 0);
    if (eeprom) {
        pi5_boot_flash(s, eeprom, gic);
    }
    DeviceState *systimer = qdev_new(TYPE_BCM2835_SYSTIMER);
    sysbus_realize_and_unref(SYS_BUS_DEVICE(systimer), &error_fatal);
    sysbus_mmio_map(SYS_BUS_DEVICE(systimer), 0, 0x107c003000);
    for (unsigned i = 0; i < 4; i++) {
        sysbus_connect_irq(SYS_BUS_DEVICE(systimer), i, qdev_get_gpio_in(gic, 64 + i));
    }
    pl011_create(0x107d001000, qdev_get_gpio_in(gic, 121), serial_hd(0));
    qdev_prop_set_uint8(host, "sd-spec-version", 3);
    sysbus_realize_and_unref(SYS_BUS_DEVICE(host), &error_fatal);
    sysbus_mmio_map(SYS_BUS_DEVICE(host), 0, 0x1000fff000);
    sysbus_connect_irq(SYS_BUS_DEVICE(host), 0, qdev_get_gpio_in(gic, 273));
    if (sd) {
        DeviceState *card = qdev_new(TYPE_SD_CARD);
        qdev_prop_set_drive_err(card, "drive", blk_by_legacy_dinfo(sd), &error_fatal);
        qdev_realize_and_unref(card, qdev_get_child_bus(host, "sd-bus"), &error_fatal);
    }
    DeviceState *wifi_host = qdev_new(TYPE_SYSBUS_SDHCI);
    qdev_prop_set_uint8(wifi_host, "sd-spec-version", 3);
    sysbus_realize_and_unref(SYS_BUS_DEVICE(wifi_host), &error_fatal);
    sysbus_mmio_map(SYS_BUS_DEVICE(wifi_host), 0, 0x1001100000);
    sysbus_connect_irq(SYS_BUS_DEVICE(wifi_host), 0, qdev_get_gpio_in(gic, 274));
    qdev_realize_and_unref(qdev_new("pi5-wifi"), qdev_get_child_bus(wifi_host, "sd-bus"), &error_fatal);
    memory_region_init_ram_nomigrate(&s->wifi_cfg, OBJECT(s), "wifi.cfg", 0x200, &error_fatal);
    memory_region_add_subregion(get_system_memory(), 0x1001100400, &s->wifi_cfg);
    /* SD power and clock configuration latches, fixed 3.3V slot. */
    memory_region_init_ram_nomigrate(&s->sd_cfg, OBJECT(s), "sd.cfg", 0x200, &error_fatal);
    memory_region_init_ram_nomigrate(&s->sd_busisol, OBJECT(s), "sd.busisol", 4, &error_fatal);
    memory_region_init_ram_nomigrate(&s->sd_lcpll, OBJECT(s), "sd.lcpll", 0x24, &error_fatal);
    memory_region_add_subregion(get_system_memory(), 0x1000fff400, &s->sd_cfg);
    memory_region_add_subregion(get_system_memory(), 0x10015040b0, &s->sd_busisol);
    memory_region_add_subregion(get_system_memory(), 0x10015200f0, &s->sd_lcpll);
    s->gnss.gpio = &s->gpio;
    s->gnss.uart = qemu_chr_new("hat-gnss", "null", NULL);
    DeviceState *uart0 = qdev_new(TYPE_PL011);
    qdev_prop_set_chr(uart0, "chardev", s->gnss.uart);
    sysbus_realize_and_unref(SYS_BUS_DEVICE(uart0), &error_fatal);
    memory_region_add_subregion(&s->rp1_io, 0x30000, sysbus_mmio_get_region(SYS_BUS_DEVICE(uart0), 0));
    sysbus_connect_irq(SYS_BUS_DEVICE(uart0), 0, qemu_allocate_irq(rp1_input, pcie, 25));
    s->gnss.timer = timer_new_us(QEMU_CLOCK_VIRTUAL, hat_gnss_tick, &s->gnss);
    qemu_register_reset(pi5_reset, s);
    s->boot.modify_dtb = pi5_modify_dtb;
    s->boot.ram_size = MIN(ms->ram_size, GiB);
    if (ms->firmware) {
        pi5_load_armstub(s, ms, ARM_CPU(cpu[0]));
        return;
    }
    s->boot.psci_conduit = QEMU_PSCI_CONDUIT_SMC;
    arm_load_kernel(ARM_CPU(cpu[0]), ms, &s->boot);
}

static void pi5_set_bootconf(Object *obj, const char *path, Error **errp)
{
    Pi5State *s = PI5(obj);
    g_free(s->bootconf_file);
    s->bootconf_file = g_strdup(path);
}

static void pi5_finalize(Object *obj)
{
    g_free(PI5(obj)->bootconf_file);
}

static void pi5_class_init(ObjectClass *oc, const void *data)
{
    MachineClass *mc = MACHINE_CLASS(oc);
    object_class_property_add_str(oc, "bootloader-config", NULL, pi5_set_bootconf);
    mc->desc = "Raspberry Pi 5 Model B (BCM2712, RP1, Seeed WM1302)";

    mc->init = pi5_init;
    mc->default_cpus = mc->min_cpus = mc->max_cpus = CORES;
    mc->default_ram_id = "bcm2712.ram";
    mc->default_ram_size = 2 * GiB;
    mc->default_cpu_type = ARM_CPU_TYPE_NAME("cortex-a76");
}

static const TypeInfo pi5_type = {
    .name = TYPE_PI5,
    .parent = TYPE_MACHINE,
    .instance_size = sizeof(Pi5State),
    .class_init = pi5_class_init,
    .instance_finalize = pi5_finalize,
};
static void pi5_register(void)
{
    type_register_static(&pi5_type);
}
type_init(pi5_register)
