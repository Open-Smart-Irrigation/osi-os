/* Compile for the guest against the OSI image's libloragw-sx1302. */
#include <inttypes.h>
#include <termios.h>
#include <time.h>
#include <fcntl.h>
#include <linux/gpio.h>
#include <linux/i2c.h>
#include <linux/i2c-dev.h>
#include <linux/spi/spidev.h>
#include <sys/ioctl.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>
#include "loragw_hal.h"
#include "loragw_reg.h"
#include "loragw_sx1302.h"
#include "loragw_sx1250.h"

static int check_atecc(void)
{
    int fd = open("/dev/i2c-1", O_RDWR);
    uint8_t token = 0, buf[7];
    struct i2c_msg msg = {.addr = 0, .len = 1, .buf = &token};
    struct i2c_rdwr_ioctl_data req = {.msgs = &msg, .nmsgs = 1};
    if (fd < 0) {
        perror("HAT I2C bus");
        return 1;
    }
    ioctl(fd, I2C_RDWR, &req); /* no ACK is expected from the wake token */
    usleep(3000);
    const uint8_t awake[] = {4, 0x11, 0x33, 0x43};
    const uint8_t revision[] = {7, 0, 0, 0x60, 3, 0x83, 0xbb};
    uint8_t info[] = {3, 7, 0x30, 0, 0, 0, 3, 0x5d};
    msg = (struct i2c_msg){.addr = 0x59, .flags = I2C_M_RD, .len = sizeof(awake), .buf = buf};
    if (ioctl(fd, I2C_RDWR, &req) != 1 || memcmp(buf, awake, sizeof(awake))) {
        fprintf(stderr, "ATECC608B wake response unavailable\n");
        return 1;
    }
    msg = (struct i2c_msg){.addr = 0x59, .len = sizeof(info), .buf = info};
    if (ioctl(fd, I2C_RDWR, &req) != 1) {
        return 1;
    }
    usleep(5000);
    msg = (struct i2c_msg){.addr = 0x59, .flags = I2C_M_RD, .len = sizeof(buf), .buf = buf};
    int valid = ioctl(fd, I2C_RDWR, &req) == 1 && !memcmp(buf, revision, sizeof(revision));
    close(fd);
    if (!valid) {
        fprintf(stderr, "ATECC608B silicon revision response mismatch\n");
    } else {
        puts("ATECC608B wake and silicon revision verified");
    }
    return !valid;
}

static int check_gnss(void)
{
    int fd = open("/dev/ttyAMA0", O_RDONLY | O_NOCTTY | O_NONBLOCK);
    struct termios serial;
    if (fd < 0 || tcgetattr(fd, &serial)) {
        perror("L76KB UART");
        return 1;
    }
    cfmakeraw(&serial);
    cfsetispeed(&serial, B9600);
    cfsetospeed(&serial, B9600);
    if (tcsetattr(fd, TCSANOW, &serial)) {
        return 1;
    }
    char sentence[96];
    size_t length = 0;
    unsigned valid = 0;
    time_t deadline = time(NULL) + 5;
    while (time(NULL) < deadline && valid != 3) {
        char c;
        if (read(fd, &c, 1) != 1) {
            usleep(1000);
            continue;
        }
        if (c == '$') {
            length = 0;
        } else if (c == '\n' && length < sizeof(sentence)) {
            sentence[length] = 0;
            char *star = strchr(sentence, '*');
            if (star) {
                unsigned check = 0, wire;
                for (char *p = sentence; p != star; ++p) {
                    check ^= (unsigned char)*p;
                }
                if (sscanf(star + 1, "%2x", &wire) == 1 && wire == check) {
                    if (strncmp(sentence, "GPRMC,", 6) == 0) { valid |= 1; }
                    if (strncmp(sentence, "GPGGA,", 6) == 0) { valid |= 2; }
                }
            }
        } else if (length < sizeof(sentence)) {
            sentence[length++] = c;
        }
    }
    close(fd);
    if (valid == 3) {
        puts("L76KB fixture delivered valid RMC and GGA on ttyAMA0");
    }
    return valid != 3;
}

static int packet_test(void)
{
    struct lgw_pkt_rx_s rx;
    const char payload[] = "OSI uplink";
    puts("WM1302_READY_FOR_UPLINK");
    fflush(stdout);
    for (int poll = 0; poll < 100; poll++) {
        int n = lgw_receive(1, &rx);
        if (n < 0) {
            return 1;
        }
        if (n == 1) {
            if (rx.size != sizeof(payload) - 1 || memcmp(rx.payload, payload, rx.size) ||
                rx.status != STAT_CRC_OK || rx.if_chain != 0 || rx.datarate != DR_LORA_SF7) {
                fprintf(stderr, "unexpected RX metadata: size %u status %u IF %u DR %u\n",
                        rx.size, rx.status, rx.if_chain, rx.datarate);
                return 1;
            }
            struct lgw_pkt_tx_s tx = {
                .tx_mode = IMMEDIATE, .rf_chain = 0, .freq_hz = 923300000,
                .rf_power = 14, .modulation = MOD_LORA, .bandwidth = BW_500KHZ,
                .datarate = DR_LORA_SF7, .coderate = CR_LORA_4_5,
                .size = 12, .payload = "OSI downlink",
            };
            uint32_t now;
            if (lgw_send(&tx) || lgw_get_instcnt(&now)) {
                return 1;
            }
            usleep(100000);
            tx.tx_mode = TIMESTAMPED;
            tx.count_us = now + 500000;
            tx.payload[0] = 'T';
            if (lgw_send(&tx)) {
                return 1;
            }
            uint8_t status;
            if (lgw_status(0, TX_STATUS, &status) || status != TX_SCHEDULED) {
                return 1;
            }
            usleep(650000);
            return lgw_status(0, TX_STATUS, &status) || status != TX_FREE;
        }
        usleep(100000);
    }
    fprintf(stderr, "timed out waiting for HAL uplink\n");
    return 1;
}

static int sample_boot_flash(void)
{
    const uint32_t offsets[] = {0, 0x80000, 0x1fff00};
    uint8_t tx[260] = {0x9f}, rx[260];
    struct spi_ioc_transfer transfer = {
        .tx_buf = (uintptr_t)tx, .rx_buf = (uintptr_t)rx,
        .len = 4, .speed_hz = 1000000, .bits_per_word = 8,
    };
    int fd = open("/dev/spidev10.0", O_RDWR);
    if (fd < 0 || ioctl(fd, SPI_IOC_MESSAGE(1), &transfer) != 4 ||
        memcmp(rx + 1, "\xc2\x20\x15", 3)) {
        fprintf(stderr, "SPI10 boot flash JEDEC identification failed\n");
        return 1;
    }
    tx[0] = 3; /* JEDEC READ */
    transfer.len = sizeof(tx);
    for (unsigned i = 0; i < sizeof(offsets) / sizeof(offsets[0]); i++) {
        tx[1] = offsets[i] >> 16;
        tx[2] = offsets[i] >> 8;
        tx[3] = offsets[i];
        if (ioctl(fd, SPI_IOC_MESSAGE(1), &transfer) != sizeof(tx) ||
            fwrite(rx + 4, 1, 256, stdout) != 256) {
            perror("SPI10 read");
            return 1;
        }
    }
    close(fd);
    return fflush(stdout) != 0;
}

int main(int argc, char **argv)
{
    if (argc == 2 && !strcmp(argv[1], "--boot-flash")) {
        return sample_boot_flash();
    }
    if (check_gnss() || check_atecc()) {
        return 1;
    }
    sx1302_model_id_t model;
    uint64_t eui;
    int32_t version;
    if (lgw_connect(LGW_COM_SPI, "/dev/spidev0.0") != 0) {
        return 1;
    }
    int gpio = open("/dev/gpiochip0", O_RDONLY);
    struct gpio_v2_line_request lines = {
        .num_lines = 2, .offsets = {18, 17}, .config.flags = GPIO_V2_LINE_FLAG_OUTPUT,
        .consumer = "wm1302-probe",
    };
    if (gpio < 0 || ioctl(gpio, GPIO_V2_GET_LINE_IOCTL, &lines) < 0) {
        perror("WM1302 carrier lines");
        return 1;
    }
    struct gpio_v2_line_values pins = {.mask = 3, .bits = 3};
    if (ioctl(lines.fd, GPIO_V2_LINE_SET_VALUES_IOCTL, &pins) < 0 ||
        lgw_reg_r(SX1302_REG_COMMON_VERSION_VERSION, &version) != 0 || version != 0xff) {
        return 1;
    }
    /* HAT SKU 113100022 supplies the rail independently of GPIO18. */
    pins.bits = 0;
    if (ioctl(lines.fd, GPIO_V2_LINE_SET_VALUES_IOCTL, &pins) < 0) {
        return 1;
    }
    int ok = lgw_reg_r(SX1302_REG_COMMON_VERSION_VERSION, &version) == 0 &&
             version == 0x10 &&
             sx1302_get_model_id(&model) == 0 && model == CHIP_MODEL_ID_SX1302 &&
             sx1302_get_eui(&eui) == 0 && eui == UINT64_C(0x020000fffe000001);
    for (unsigned chain = 0; ok && chain < 2; chain++) {
        uint32_t hz = chain ? 924300000 : 902300000;
        uint8_t freq[] = {0x08, 0x8b, 0, 0, 0, 0, 0};
        uint8_t status = 0;
        ok = sx1250_calibrate(chain, hz) == 0 && sx1250_setup(chain, hz, false) == 0 &&
             sx1250_reg_r(READ_REGISTER, freq, sizeof(freq), chain) == 0 &&
             sx1250_reg_r(GET_STATUS, &status, 1, chain) == 0;
        uint32_t readback = (uint32_t)freq[3] << 24 | (uint32_t)freq[4] << 16 |
                            (uint32_t)freq[5] << 8 | freq[6];
        ok = ok && readback == SX1250_FREQ_TO_REG(hz) && (status >> 4) == 5;
        if (ok) {
            printf("SX1250 chain %u in RX mode at %u Hz\n", chain, hz);
        }
    }
    if (ok) {
        printf("SX1302 silicon version %02x, model %d, test EUI %016" PRIx64 "\n",
               (unsigned)version, model, eui);
    }
    if (lgw_disconnect() != 0 || !ok) {
        return 1;
    }
    struct lgw_conf_board_s board = {
        .com_type = LGW_COM_SPI, .com_path = "/dev/spidev0.0", .lorawan_public = true,
    };
    struct lgw_conf_rxrf_s rf = {
        .enable = true, .tx_enable = true, .freq_hz = 904300000, .type = LGW_RADIO_TYPE_SX1250,
    };
    lgw_i2c_set_path("/dev/i2c-1");
    lgw_i2c_set_temp_sensor_addr(0x39);
    struct lgw_conf_rxif_s channel = {.enable = true, .rf_chain = 0};
    struct lgw_tx_gain_lut_s gains = {.size = 1, .lut = {{.rf_power = 14, .mix_gain = 5}}};
    struct lgw_conf_demod_s demod = {.multisf_datarate = 1u << (7 - 5)};
    if (lgw_board_setconf(&board) || lgw_demod_setconf(&demod) || lgw_rxrf_setconf(0, &rf) ||
        lgw_rxif_setconf(0, &channel) || lgw_txgain_setconf(0, &gains) || lgw_start()) {
        return 1;
    }
    uint32_t pps, next;
    if (lgw_get_trigcnt(&pps)) {
        return 1;
    }
    bool advanced = false;
    for (unsigned i = 0; i < 30; i++) {
        usleep(50000);
        if (lgw_get_trigcnt(&next)) {
            return 1;
        }
        if (next != pps) {
            advanced = next - pps == 1000000;
            break;
        }
    }
    if (!advanced) {
        fprintf(stderr, "missing one-second PPS at concentrator timestamp input\n");
        return 1;
    }
    puts("GNSS PPS captured by the SX1302 timestamp counter");
    float temperature;
    if (lgw_get_temperature(&temperature) || temperature != 25.0f) {
        return 1;
    }
    printf("Semtech lgw_start completed, STTS751 %.1f C\n", temperature);
    int failed = argc == 2 && strcmp(argv[1], "--packets") == 0 && packet_test();
    return lgw_stop() != 0 || failed;
}
