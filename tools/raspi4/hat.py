"""Apply OSI hardware attachments to a disposable pinned QEMU build tree."""
from pathlib import Path
import shutil
import sys

here = Path(__file__).resolve().parent
arm = Path(sys.argv[1]) / 'hw/arm'


def replace(path, old, new):
    source = path.read_text()
    if new in source:
        return
    if source.count(old) != 1:
        raise ValueError(f'unexpected QEMU source at {path}')
    path.write_text(source.replace(old, new))


# QEMU renamed the character frontend type and moved the irq header.
header = (here.parent/'raspi5/wm1302-spi.h').read_text()
(arm/'wm1302-spi.h').write_text(header.replace('CharBackend air', 'CharFrontend air')
                                .replace('"hw/irq.h"', '"hw/core/irq.h"'))
shutil.copyfile(here/'hardware.c.inc', arm/'pi4-hardware.c.inc')
replace(arm/'raspi4b.c', '#include <libfdt.h>', '#include <libfdt.h>\n#include "pi4-hardware.c.inc"')
replace(arm/'raspi4b.c', 'raspi_base_machine_init(machine, &soc->parent_obj);',
        'raspi_base_machine_init(machine, &soc->parent_obj);\n    pi4_connect_hat(&soc->peripherals);')
# On Pi 4 the removable card lives on the dedicated eMMC2 pins.
replace(arm/'bcm2838_peripherals.c', '"sd-bus", OBJECT(&s->gpio), "sd-bus"',
        '"sd-bus", OBJECT(&s->emmc2), "sd-bus"')
# The candidate BCM2711 DT maps PCI bus addresses 0x80000000..0xffffffff
# onto CPU physical 0x600000000, as programmed by its host bridge driver.
replace(arm/'bcm2838_peripherals.c', 'PCIE_MMIO_OFFSET        0xc0000000',
        'PCIE_MMIO_OFFSET        0x80000000')
replace(arm/'bcm2838_peripherals.c', 'PCIE_MMIO_SIZE          0x40000000',
        'PCIE_MMIO_SIZE          0x80000000')
prop = arm.parent/'misc/bcm2835_property.c'
fields = arm.parents[1]/'include/hw/misc/bcm2835_property.h'
replace(fields, '    MACAddr macaddr;', '    uint8_t expander[8][5];\n    MACAddr macaddr;')
replace(prop, '        case RPI_FWREQ_GET_TEMPERATURE:',
        (here/'expander.c.inc').read_text()+'        case RPI_FWREQ_GET_TEMPERATURE:')
replace(prop, '    .version_id = 1,', '    .version_id = 2,')
replace(prop, '        VMSTATE_BOOL(pending, BCM2835PropertyState),',
        '        VMSTATE_BOOL(pending, BCM2835PropertyState),\n'
        '        VMSTATE_UINT8_2DARRAY_V(expander, BCM2835PropertyState, 8, 5, 2),')
replace(prop, '    s->pending = false;\n}', '    memset(s->expander, 0, sizeof(s->expander));\n    s->pending = false;\n}')
