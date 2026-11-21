/* SPDX-License-Identifier: GPL-2.0-or-later */
/* L76KB NMEA output fixture. The carrier routes its PPS to WM1302 pin 19. */
#ifndef OSI_HAT_GNSS_H
#define OSI_HAT_GNSS_H
typedef struct HatGnss {
    QEMUTimer *timer;
    Chardev *uart;
    Rp1Gpio *gpio;
    char sentences[192];
    unsigned length, index;
    int64_t second;
} HatGnss;

static int nmea_format(char *dest, size_t capacity, const char *body)
{
    uint8_t checksum = 0;
    for (const char *c = body; *c; ++c) {
        checksum ^= *c;
    }
    return g_snprintf(dest, capacity, "$%s*%02X\r\n", body, checksum);
}

static void hat_gnss_tick(void *opaque)
{
    HatGnss *g = opaque;
    int64_t now = qemu_clock_get_us(QEMU_CLOCK_VIRTUAL);
    int64_t sec = now / 1000000;
    uint32_t pins = g->gpio->regs[1][0][0] & g->gpio->regs[1][0][1];
    if (sec != g->second) {
        g->second = sec;
        g->index = g->length = 0;
        if (!(pins & (1u << 25))) {
            /* Synthetic position at 0 N, 0 E. Epoch is 2025-01-01 UTC. */
            g_autoptr(GDateTime) date = g_date_time_new_from_unix_utc(1735689600 + sec);
            g_autofree char *utc = g_date_time_format(date, "%H%M%S");
            g_autofree char *day = g_date_time_format(date, "%d%m%y");
            char body[88];
            g_snprintf(body, sizeof(body), "GPRMC,%s.00,A,0000.0000,N,00000.0000,E,0.0,0.0,%s,,,A", utc, day);
            g->length = nmea_format(g->sentences, sizeof(g->sentences), body);
            g_snprintf(body, sizeof(body), "GPGGA,%s.00,0000.0000,N,00000.0000,E,1,08,1.0,0.0,M,0.0,M,,", utc);
            g->length += nmea_format(g->sentences + g->length, sizeof(g->sentences) - g->length, body);
            WmSpiState *spi = g->gpio->spi;
            if (spi->active) {
                spi->pps = (sec * 1000000 - spi->reset_us) * 32;
            }
        }
    }
    if (pins & (1u << 25)) {
        g->index = g->length;
    }
    /* One 8N1 character per 1042 us at 9600 baud. */
    if (g->index < g->length && qemu_chr_be_can_write(g->uart)) {
        qemu_chr_be_write(g->uart, (uint8_t *)g->sentences + g->index, 1);
        g->index++;
    }
    timer_mod(g->timer, g->index < g->length ? now + 1042 : (sec + 1) * 1000000);
}
#endif
