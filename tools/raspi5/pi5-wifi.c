/* SPDX-License-Identifier: GPL-2.0-or-later */
/* Included by hw/sd/sd.c, which owns the private SDState layout. */
#define TYPE_PI5_WIFI "pi5-wifi"
OBJECT_DECLARE_SIMPLE_TYPE(Pi5WifiState, PI5_WIFI)

struct Pi5WifiState {
    SDState parent_obj;
    uint8_t cccr[0x300];
};

static void pi5_wifi_reset(DeviceState *dev)
{
    Pi5WifiState *s = PI5_WIFI(dev);
    memset(s->cccr, 0, sizeof(s->cccr));
    s->parent_obj.dat_lines = 0xf;
    s->parent_obj.cmd_line = true;
    s->cccr[0] = 0x32; /* SDIO 2.0 */
    s->cccr[1] = 2;
    for (unsigned fn = 0; fn <= 2; fn++) {
        s->cccr[fn * 256 + 10] = 0x10 + fn;
    }
}

static uint32_t pi5_wifi_direct(Pi5WifiState *s, uint32_t arg)
{
    static const uint8_t common[] = {
        0x20, 4, 0xd0, 0x02, 0xbf, 0xa9, /* Broadcom 43455 */
        0x22, 4, 0, 0, 2, 0x32, 0xff
    };
    static const uint8_t function[] = {
        0x22, 42, 1, [2 + 13] = 2, [2 + 28] = 10, [44] = 0xff
    };
    unsigned address = extract32(arg, 9, 17);
    if (extract32(arg, 28, 3)) {
        return 1 << 11; /* Backplane and WLAN data functions unavailable. */
    }
    if (address >= 0x1000 && address < 0x1300) {
        unsigned offset = address & 255;
        if (address < 0x1100) {
            return offset < sizeof(common) ? common[offset] : 0xff;
        }
        return offset < sizeof(function) ? function[offset] : 0xff;
    }
    if (address >= sizeof(s->cccr)) {
        return 1 << 8;
    }
    if (arg & BIT(31)) {
        switch (address) {
        case 2: case 4: case 7: case 0x10: case 0x11:
        case 0x110: case 0x111: case 0x210: case 0x211:
            s->cccr[address] = arg;
            break;
        case 6:
            if (arg & 8) {
                pi5_wifi_reset(DEVICE(s));
            }
            break;
        }
    }
    return s->cccr[address];
}

static size_t pi5_wifi_command(SDState *sd, SDRequest *r, uint8_t *out, size_t len)
{
    uint32_t response;
    if (len < 4) {
        return 0;
    }
    switch (r->cmd) {
    case 0:
        pi5_wifi_reset(DEVICE(sd));
        return 0;
    case 3:
        response = 1 << 16; /* relative card address */
        break;
    case 5:
        response = 0xa0ff8000; /* ready, two I/O functions, 3.3 V */
        break;
    case 7: case 13:
        response = 0x900; /* transfer state, ready */
        break;
    case 52:
        response = pi5_wifi_direct(PI5_WIFI(sd), r->arg);
        break;
    case 53:
        response = 1 << 11;
        break;
    default:
        return 0;
    }
    stl_be_p(out, response);
    return 4;
}

static bool pi5_wifi_inserted(SDState *sd)
{
    return true;
}

static void pi5_wifi_realize(DeviceState *dev, Error **errp)
{
    pi5_wifi_reset(dev);
}

static void pi5_wifi_class_init(ObjectClass *klass, const void *data)
{
    DeviceClass *dc = DEVICE_CLASS(klass);
    SDCardClass *sc = SDMMC_COMMON_CLASS(klass);
    dc->realize = pi5_wifi_realize;
    dc->user_creatable = false;
    dc->vmsd = NULL;
    device_class_set_legacy_reset(dc, pi5_wifi_reset);
    sc->get_inserted = pi5_wifi_inserted;
    sc->do_command = pi5_wifi_command;
}

static const TypeInfo pi5_wifi_types[] = {{
    .name = TYPE_PI5_WIFI, .parent = TYPE_SD_CARD,
    .instance_size = sizeof(Pi5WifiState), .class_init = pi5_wifi_class_init,
}};
DEFINE_TYPES(pi5_wifi_types)
