"""Read the Pi boot file selections and DT changes used by OSI factory images."""
import re
import subprocess
from pathlib import PurePosixPath


def fat_name(name):
    path = PurePosixPath(name)
    if (not path.parts or path.is_absolute() or '..' in path.parts or
            not re.fullmatch(r'[a-zA-Z0-9_./+-]+', name)):
        raise ValueError(f'invalid FAT boot path {name!r}')
    return '::' + str(path)


def load(volume, work, dtmerge, *, quiet=False):
    stderr = subprocess.DEVNULL if quiet else None
    stdout = subprocess.DEVNULL if quiet else None
    selected = {'kernel': '', 'armstub': '', 'device_tree': 'bcm2712-rpi-5-b.dtb',
                'cmdline': 'cmdline.txt'}
    changes = []
    prefix = ''
    overlay_prefix = 'overlays/'

    def read(name, parents):
        nonlocal prefix, overlay_prefix
        if name in parents or len(parents) > 16:
            raise ValueError(f'recursive config.txt include {name!r}')
        raw = subprocess.check_output(['mtype', '-i', volume, fat_name(name)], stderr=stderr)
        active = True
        for line in raw.decode('utf-8-sig').splitlines():
            line = line.partition('#')[0].strip()
            if line.startswith('[') and line.endswith(']'):
                group = line[1:-1].lower()
                if group in ('all', 'pi5'):
                    active = True
                elif group == 'none' or re.fullmatch(r'(?:pi|cm)[0-9a-z]+', group):
                    active = False
                else:
                    raise ValueError(f'unsupported firmware filter [{group}] in {name}')
            elif active and line.startswith('include '):
                read(line.split(None, 1)[1], parents + [name])
            elif active and '=' in line:
                key, value = (part.strip() for part in line.split('=', 1))
                if key in selected:
                    selected[key] = value
                elif key == 'os_prefix':
                    prefix = value
                elif key == 'overlay_prefix':
                    overlay_prefix = value
                elif key == 'dtoverlay' and value:
                    overlay, *params = value.split(',')
                    changes.append((overlay_prefix + overlay + '.dtbo', params))
                elif key == 'dtparam':
                    changes.append((None, value.split(',')))

    read('config.txt', [])

    def exists(path):
        return subprocess.run(['mdir', '-i', volume, fat_name(path)], stdout=subprocess.DEVNULL,
                              stderr=subprocess.DEVNULL).returncode == 0

    def kernel_name(base):
        if selected['kernel']:
            return selected['kernel']
        return 'kernel_2712.img' if exists(base + 'kernel_2712.img') else 'kernel8.img'

    if prefix and not (exists(prefix + kernel_name(prefix)) and exists(prefix + selected['device_tree'])):
        prefix = ''
    selected['kernel'] = kernel_name(prefix)
    if selected['armstub']:
        subprocess.run(['mcopy', '-i', volume, fat_name(selected['armstub']), work / 'armstub.bin'],
                       check=True, stdout=stdout, stderr=stderr)
    overlay_base = prefix if prefix and exists(prefix + overlay_prefix + 'README') else ''
    for key, destination in [('kernel', 'kernel_2712.img'), ('device_tree', 'bcm2712-rpi-5-b.dtb'),
                             ('cmdline', 'cmdline.txt')]:
        subprocess.run(['mcopy', '-i', volume, fat_name(prefix + selected[key]), work / destination],
                       check=True, stdout=stdout, stderr=stderr)
    dtb = work / 'bcm2712-rpi-5-b.dtb'
    merged = work / 'merged.dtb'
    for overlay, params in changes:
        source = '-'
        if overlay:
            source = str(work / 'overlay.dtbo')
            subprocess.run(['mcopy', '-o', '-i', volume, fat_name(overlay_base + overlay), source],
                           check=True, stdout=stdout, stderr=stderr)
        subprocess.run([dtmerge, dtb, merged, source, *params], check=True, stdout=stdout, stderr=stderr)
        merged.replace(dtb)


def read_eeprom(image, extractor, work):
    """Read Pi 5 EEPROM configuration and select the attached SD boot medium."""
    if image.stat().st_size != 2 * 1024 * 1024:
        raise ValueError('expected a 2 MiB BCM2712 EEPROM image')
    config = subprocess.check_output([extractor, str(image.resolve())])
    if not config or len(config) > 4096:
        raise ValueError('EEPROM configuration is empty or exceeds one sector')
    active = True
    order = 0xf461
    for raw in config.decode('ascii').splitlines():
        line = raw.partition('#')[0].strip()
        if line.startswith('['):
            if line not in ('[all]', '[pi5]', '[none]'):
                raise ValueError(f'unsupported EEPROM filter {line}')
            active = line != '[none]'
        elif active and '=' in line:
            key, value = (part.strip() for part in line.split('=', 1))
            if key == 'BOOT_ORDER':
                order = int(value, 0)
            elif key == 'SIGNED_BOOT' and int(value, 0):
                raise ValueError('EEPROM requires signed boot, which the machine cannot verify')
    if order < 0 or order > 0xffffffff:
        raise ValueError('BOOT_ORDER exceeds its 32-bit range')
    for _ in range(8):
        mode = order & 15
        if mode == 1:
            (work / 'bootconf.txt').write_bytes(config)
            return
        if mode in (14, 15):
            break
        order >>= 4
    raise ValueError('EEPROM BOOT_ORDER does not reach the attached SD card')
