/* SPDX-License-Identifier: GPL-2.0-or-later */
/* ATECC608B-TNGLORAS-G discovery on the carrier's shared I2C bus. */
#ifndef OSI_HAT_ATECC_H
#define OSI_HAT_ATECC_H

typedef struct HatAtecc {
    uint8_t command[156], response[7], used, index, word;
    int64_t awake_until;
} HatAtecc;

static uint16_t atecc_crc(const uint8_t *packet, size_t size)
{
    uint16_t crc = 0;
    for (size_t i = 0; i < size; ++i) {
        for (unsigned bit = 0; bit < 8; ++bit) {
            bool feedback = ((crc >> 15) ^ (packet[i] >> bit)) & 1;
            crc = (crc << 1) ^ (feedback ? 0x8005 : 0);
        }
    }
    return crc;
}

static void atecc_reply(HatAtecc *a, const uint8_t *data, unsigned count)
{
    a->response[0] = count + 3;
    memcpy(a->response + 1, data, count);
    stw_le_p(a->response + count + 1, atecc_crc(a->response, count + 1));
    a->index = 0;
}

static void atecc_wake(HatAtecc *a)
{
    uint8_t wake = 0x11;
    a->used = 0;
    a->awake_until = qemu_clock_get_us(QEMU_CLOCK_VIRTUAL) + 1300000;
    atecc_reply(a, &wake, 1);
}

static void atecc_write(HatAtecc *a, uint8_t byte, bool first, bool stop)
{
    if (first) {
        a->word = byte;
        if (byte == 1 || byte == 2) {
            a->awake_until = 0;
            a->used = 0;
        } else if (byte == 0) {
            a->index = 0;
        }
    } else if (a->word == 3 && a->used < sizeof(a->command)) {
        a->command[a->used++] = byte;
    }
    if (stop && a->word == 3 && a->used && a->used >= a->command[0]) {
        uint8_t status = 0x03;
        static const uint8_t revision[] = {0, 0, 0x60, 3};
        unsigned len = a->command[0];
        if (len < 7 || atecc_crc(a->command, len - 2) != lduw_le_p(a->command + len - 2)) {
            status = 0xff;
        } else if (len == 7 && a->command[1] == 0x30 &&
                   !a->command[2] && !lduw_le_p(a->command + 3)) {
            atecc_reply(a, revision, sizeof(revision));
            a->used = 0;
            return;
        }
        atecc_reply(a, &status, 1);
        a->used = 0;
    }
}
#endif
