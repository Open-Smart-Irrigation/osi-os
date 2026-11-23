/* SPDX-License-Identifier: GPL-2.0-or-later */
        /* Firmware GPIOs 128..135 on the Pi 4 board expander.
         * The SD regulators use the direction, polarity and output state.
         */
        case 0x30041: /* get state */
        case 0x38041: /* set state */
        case 0x30043: /* get configuration */
        case 0x38043: { /* set configuration */
            bool config = (tag & 0xff) == 0x43;
            bool write = (tag & 0x8000) != 0;
            unsigned count = config ? (write ? 5 : 4) : 1;
            if (bufsize < 4 * (count + 1)) {
                break;
            }
            uint32_t pin = ldl_le_phys(&s->dma_as, value + 12) - 128;
            if (pin >= ARRAY_SIZE(s->expander)) {
                stl_le_phys(&s->dma_as, value + 12, 1);
                resplen = 4;
                break;
            }
            for (unsigned i = 0; i < count; i++) {
                uint8_t *field = &s->expander[pin][config ? i : 4];
                if (write) {
                    *field = ldl_le_phys(&s->dma_as, value + 16 + 4 * i) & 1;
                } else {
                    stl_le_phys(&s->dma_as, value + 16 + 4 * i, *field);
                }
            }
            stl_le_phys(&s->dma_as, value + 12, 0);
            resplen = 4 * (count + 1);
            break;
        }
