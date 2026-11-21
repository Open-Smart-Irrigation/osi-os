/* SPDX-License-Identifier: GPL-2.0-or-later */
/* Included by the pinned QEMU raspi4b machine. */
#include "wm1302-spi.h"

typedef struct {
    SSIPeripheral parent;
    WmSpiState chip;
    QEMUTimer *pps_timer;
    bool gnss_in_reset;
} Pi4Radio;

static uint32_t pi4_spi_transfer(SSIPeripheral *dev, uint32_t data)
{
    return wm1302_exchange(&((Pi4Radio *)dev)->chip, data);
}

static int pi4_spi_cs(SSIPeripheral *dev, bool high)
{
    ((Pi4Radio *)dev)->chip.phase = 0;
    return 0;
}

static void pi4_radio_reset(void *opaque, int line, int high)
{
    WmSpiState *chip = opaque;
    if (high) {
        wm_chip_reset(chip);
    } else {
        chip->reset_us = qemu_clock_get_us(QEMU_CLOCK_VIRTUAL);
    }
    chip->active = !high;
}

/* The L76KB PPS output is wired to the concentrator on the Seeed HAT. */
static void pi4_pps(void *opaque)
{
    Pi4Radio *radio = opaque;
    int64_t now = qemu_clock_get_us(QEMU_CLOCK_VIRTUAL);
    int64_t edge = now - now % 1000000;
    if (radio->chip.active && !radio->gnss_in_reset && edge >= radio->chip.reset_us) {
        radio->chip.pps = (edge - radio->chip.reset_us) * 32;
    }
    timer_mod(radio->pps_timer, edge + 1000000);
}

static void pi4_gnss_reset(void *opaque, int line, int level)
{
    Pi4Radio *radio = opaque;
    radio->gnss_in_reset = level;
}

static void pi4_radio_realize(SSIPeripheral *dev, Error **errp)
{
    /* The board connects the GPIOs and RF medium after bus realization. */
}

static void pi4_radio_class(ObjectClass *klass, const void *data)
{
    SSIPeripheralClass *sc = SSI_PERIPHERAL_CLASS(klass);
    sc->realize = pi4_radio_realize;
    sc->transfer = pi4_spi_transfer;
    sc->set_cs = pi4_spi_cs;
    sc->cs_polarity = SSI_CS_LOW;
}

typedef struct {
    I2CSlave parent;
    uint8_t reg[256], addr;
    bool pointer;
} Pi4Temperature;

static int pi4_temp_event(I2CSlave *dev, enum i2c_event event)
{
    if (event == I2C_START_SEND) {
        ((Pi4Temperature *)dev)->pointer = true;
    }
    return 0;
}

static int pi4_temp_write(I2CSlave *dev, uint8_t data)
{
    Pi4Temperature *t = (Pi4Temperature *)dev;
    if (t->pointer) {
        t->addr = data;
        t->pointer = false;
    } else {
        if (t->addr >= 3 && t->addr <= 0x22) {
            t->reg[t->addr] = data;
        }
        t->addr++;
    }
    return 0;
}

static uint8_t pi4_temp_read(I2CSlave *dev)
{
    Pi4Temperature *t = (Pi4Temperature *)dev;
    return t->reg[t->addr++];
}

static void pi4_temp_class(ObjectClass *klass, const void *data)
{
    I2CSlaveClass *ic = I2C_SLAVE_CLASS(klass);
    ic->event = pi4_temp_event;
    ic->send = pi4_temp_write;
    ic->recv = pi4_temp_read;
}

static const TypeInfo hat_types[] = {
    { .name = "pi4-wm1302", .parent = TYPE_SSI_PERIPHERAL,
      .instance_size = sizeof(Pi4Radio), .class_init = pi4_radio_class },
    { .name = "pi4-stts751", .parent = TYPE_I2C_SLAVE,
      .instance_size = sizeof(Pi4Temperature), .class_init = pi4_temp_class },
};
DEFINE_TYPES(hat_types)

static void pi4_connect_hat(BCM2838PeripheralState *peri)
{
    BCMSocPeripheralBaseState *base = &peri->parent_obj;
    DeviceState *dev = ssi_create_peripheral(base->spi[0].bus, "pi4-wm1302");
    Pi4Radio *radio = (Pi4Radio *)dev;
    WmSpiState *chip = &radio->chip;
    for (unsigned i = 0; i < 2; i++) {
        WmTx *tx = &chip->tx[i];
        tx->chain = i;
        tx->spi = chip;
        tx->timer = timer_new_us(QEMU_CLOCK_VIRTUAL, wm_tx_event, tx);
    }
    wm_chip_reset(chip);
    chip->active = true;
    qdev_connect_gpio_out(DEVICE(&peri->gpio), 8,
                          qdev_get_gpio_in_named(dev, SSI_GPIO_CS, 0));
    qdev_connect_gpio_out(DEVICE(&peri->gpio), 17,
                          qemu_allocate_irq(pi4_radio_reset, chip, 0));
    qdev_connect_gpio_out(DEVICE(&peri->gpio), 25,
                          qemu_allocate_irq(pi4_gnss_reset, radio, 0));
    radio->pps_timer = timer_new_us(QEMU_CLOCK_VIRTUAL, pi4_pps, radio);
    pi4_pps(radio);
    Chardev *air = qemu_chr_find("wm1302-air");
    if (air) {
        qemu_chr_fe_init(&chip->air, air, &error_fatal);
        qemu_chr_fe_set_handlers(&chip->air, wm_air_space, wm_air_read,
                                 wm_air_event, NULL, chip, NULL, true);
    }
    Pi4Temperature *temp = (Pi4Temperature *)i2c_slave_create_simple(
        base->i2c[1].bus, "pi4-stts751", 0x39);
    temp->reg[0] = 25;
    temp->reg[0xfe] = 0x53;
}
