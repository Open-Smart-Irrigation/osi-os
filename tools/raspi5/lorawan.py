"""LoRaWAN 1.0 OTAA sessions for synthetic test devices."""
from __future__ import annotations

import hmac
import os
import struct


from pathlib import Path
import subprocess


def _primitive(mode, key, data):
    return subprocess.run(['node',Path(__file__).with_name('radio-crypto.cjs'),mode],
                          input=key+data,stdout=subprocess.PIPE,check=True).stdout


def _aes(key, block):
    return _primitive('aes', key, block)


def _cmac(key, data):
    return _primitive('cmac', key, data)


def _crypt(key: bytes, devaddr: int, direction: int, fcnt: int, data: bytes) -> bytes:
    out = bytearray()
    for i in range((len(data)+15)//16):
        a = b'\x01'+bytes(4)+bytes([direction])+devaddr.to_bytes(4,'little')+fcnt.to_bytes(4,'little')+b'\x00'+bytes([i+1])
        s = _aes(key, a); chunk=data[16*i:16*i+16]
        out.extend(x^y for x,y in zip(chunk,s))
    return bytes(out)


class LoRaWAN10:
    """Stateful LoRaWAN 1.0 session. Keys and identifiers are caller supplied."""
    def __init__(self, app_eui: bytes, dev_eui: bytes, app_key: bytes, *, devnonce: int | None = None):
        if any(len(x)!=8 for x in (app_eui,dev_eui)) or len(app_key)!=16: raise ValueError("EUIs must be 8 bytes; AppKey 16 bytes")
        self.app_eui,self.dev_eui,self.app_key=app_eui,dev_eui,app_key
        self.devnonce=int.from_bytes(os.urandom(2),'little') if devnonce is None else devnonce
        if not 0 <= self.devnonce <= 65535: raise ValueError("DevNonce out of range")
        self.devaddr=self.nwk_s_key=self.app_s_key=None

    def join_request(self) -> bytes:
        body=b'\x00'+self.app_eui[::-1]+self.dev_eui[::-1]+self.devnonce.to_bytes(2,'little')
        return body+_cmac(self.app_key,body)[:4]

    def accept_join(self, packet: bytes) -> dict:
        if len(packet) not in (17,33) or packet[0]!=0x20: raise ValueError("invalid join-accept PHYPayload")
        # Join-accept's encryption is AES decrypt at the network; AES encrypt reverses it.
        raw=b''.join(_aes(self.app_key,packet[i:i+16]) for i in range(1,len(packet)-4,16))
        body=packet[:1]+raw[:-4]; mic=raw[-4:]
        if not hmac.compare_digest(_cmac(self.app_key,body)[:4],mic): raise ValueError("join-accept MIC mismatch")
        appnonce=raw[0:3]; netid=raw[3:6]; devaddr=int.from_bytes(raw[6:10],'little'); dl=raw[10]
        self.devaddr=devaddr
        self.nwk_s_key=_aes(self.app_key,b'\x01'+appnonce+netid+self.devnonce.to_bytes(2,'little')+bytes(7))
        self.app_s_key=_aes(self.app_key,b'\x02'+appnonce+netid+self.devnonce.to_bytes(2,'little')+bytes(7))
        return {"devaddr":devaddr,"appnonce":appnonce,"netid":netid,"dl_settings":dl,"rx_delay":raw[11]}

    def uplink(self, payload: bytes, fcnt: int, *, fport: int=1, confirmed: bool=False, fopts: bytes=b'') -> bytes:
        if self.devaddr is None: raise ValueError("join session not established")
        if len(fopts)>15 or not 0<=fcnt<=0xffffffff or not 0<=fport<=255: raise ValueError("invalid frame parameters")
        mhdr=bytes([0x80 if confirmed else 0x40]); fhdr=self.devaddr.to_bytes(4,'little')+bytes([len(fopts)])+(fcnt & 65535).to_bytes(2,'little')+fopts
        key=self.nwk_s_key if fport==0 else self.app_s_key
        msg=mhdr+fhdr+bytes([fport])+_crypt(key,self.devaddr,0,fcnt,payload)
        b0=b'\x49'+bytes(4)+b'\x00'+self.devaddr.to_bytes(4,'little')+fcnt.to_bytes(4,'little')+b'\x00'+bytes([len(msg)])
        return msg+_cmac(self.nwk_s_key,b0+msg)[:4]

    def downlink(self, packet: bytes, *, expected_fcnt: int | None=None) -> dict:
        if self.devaddr is None or len(packet)<12 or packet[0]>>5 not in (3,5): raise ValueError("invalid downlink")
        addr=int.from_bytes(packet[1:5],'little')
        if addr!=self.devaddr: raise ValueError("DevAddr mismatch")
        fctrl=packet[5]; fopts_len=fctrl&15; fcnt16=int.from_bytes(packet[6:8],'little'); fport_pos=8+fopts_len
        if fport_pos+4>len(packet): raise ValueError("truncated downlink")
        fcnt=fcnt16 if expected_fcnt is None else (expected_fcnt&0xffff0000)|fcnt16
        msg=packet[:-4]; b0=b'\x49'+bytes(4)+b'\x01'+addr.to_bytes(4,'little')+fcnt.to_bytes(4,'little')+b'\x00'+bytes([len(msg)])
        if not hmac.compare_digest(_cmac(self.nwk_s_key,b0+msg)[:4],packet[-4:]): raise ValueError("downlink MIC mismatch")
        port=packet[fport_pos]; key=self.nwk_s_key if port==0 else self.app_s_key
        return {"devaddr":addr,"fcnt":fcnt,"fport":port,"payload":_crypt(key,addr,1,fcnt,packet[fport_pos+1:-4]),"confirmed":packet[0]>>5==5,"fopts":packet[8:8+fopts_len]}
