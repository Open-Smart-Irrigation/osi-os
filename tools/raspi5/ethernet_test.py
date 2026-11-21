"""One local Ethernet peer for the factory kernel's ARP and ICMP smoke test."""
import socket
import struct
import time


def checksum(data):
    padded = data + bytes(len(data) % 2)
    total = sum(x[0] for x in struct.iter_unpack('!H', padded))
    while total >> 16:
        total = (total & 65535) + (total >> 16)
    return ~total & 65535


def verify(sock):
    mac = bytes.fromhex('020000000002')
    ip = socket.inet_aton('192.0.2.2')
    deadline = time.monotonic() + 18
    with sock:
        def read(count):
            data = bytearray()
            while len(data) < count:
                sock.settimeout(max(.01, deadline - time.monotonic()))
                chunk = sock.recv(count - len(data))
                if not chunk:
                    raise ConnectionError('guest Ethernet closed')
                data.extend(chunk)
            return bytes(data)

        while time.monotonic() < deadline:
            length = int.from_bytes(read(4), 'big')
            if length > 65536:
                raise ValueError('invalid Ethernet frame length')
            frame = read(length)
            proto = frame[12:14]
            peer = frame[6:12]
            body = frame[14:]
            if proto == b'\x08\x06' and body[6:8] == b'\x00\x01' and body[24:28] == ip:
                reply = peer + mac + proto + body[:6] + b'\x00\x02' + mac + ip + body[8:18]
            elif proto == b'\x08\x00' and len(body) >= 28 and body[9] == 1 and body[16:20] == ip:
                hlen = (body[0] & 15) * 4
                icmp = bytearray(body[hlen:int.from_bytes(body[2:4], 'big')])
                if len(icmp) < 8 or icmp[0] != 8:
                    continue
                icmp[0:4] = bytes(4)
                struct.pack_into('!H', icmp, 2, checksum(icmp))
                hdr = bytearray(body[:hlen])
                hdr[12:20] = ip + body[12:16]
                reply = peer + mac + proto + hdr + icmp
            else:
                continue
            sock.sendall(struct.pack('!I', len(reply)) + reply)
            if proto == b'\x08\x00':
                return
    raise TimeoutError('no guest ICMP echo on eth0')
