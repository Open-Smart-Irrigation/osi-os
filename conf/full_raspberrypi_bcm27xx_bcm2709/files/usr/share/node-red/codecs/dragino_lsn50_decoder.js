function decodeUplink(input) {
        return { 
            data: Decode(input.fPort, input.bytes, input.variables)
        };   
}

/*
 * Chameleon V1 keeps the stock MOD3 prefix, then appends a 44-byte,
 * big-endian payload. Byte 8 is the Chameleon payload version marker.
 */
function readUInt16BE(bytes, offset) {
  return (bytes[offset]<<8 | bytes[offset + 1]);
}

function readInt16BE(bytes, offset) {
  var value = readUInt16BE(bytes, offset);
  return (value & 0x8000) ? value - 0x10000 : value;
}

function readUInt32BE(bytes, offset) {
  return (((bytes[offset] << 24) >>> 0) +
          (bytes[offset + 1] << 16) +
          (bytes[offset + 2] << 8) +
          bytes[offset + 3]) >>> 0;
}

function byteToHex(value) {
  var hex = value.toString(16).toUpperCase();
  return hex.length == 1 ? "0" + hex : hex;
}

function bytesToHex(bytes, offset, length) {
  var out = "";
  for(var i = 0; i < length; i++) {
    out += byteToHex(bytes[offset + i]);
  }
  return out;
}

function isChameleonV1Frame(bytes) {
  return bytes.length >= 44 && bytes[8] == 0x01;
}

function readChameleonResistance(bytes, offset, dataInvalid, channelOpen) {
  if(dataInvalid || channelOpen)
    return "NULL";
  return readUInt32BE(bytes, offset);
}

function decodeChameleonV1(decode, bytes) {
  var status_flags = bytes[9];
  var soil_temp_c_x100 = readInt16BE(bytes, 10);
  var dataInvalid;

  decode.Chameleon_Payload_Version = bytes[8];
  decode.Chameleon_Status_Flags = status_flags;
  decode.Chameleon_I2C_Missing = (status_flags & 0x01) ? true : false;
  decode.Chameleon_Timeout = (status_flags & 0x02) ? true : false;
  decode.Chameleon_Temp_Fault = (status_flags & 0x04) ? true : false;
  decode.Chameleon_ID_Fault = (status_flags & 0x08) ? true : false;
  decode.Chameleon_CH1_Open = (status_flags & 0x10) ? true : false;
  decode.Chameleon_CH2_Open = (status_flags & 0x20) ? true : false;
  decode.Chameleon_CH3_Open = (status_flags & 0x40) ? true : false;
  dataInvalid = decode.Chameleon_I2C_Missing || decode.Chameleon_Timeout;

  if(dataInvalid || decode.Chameleon_Temp_Fault || soil_temp_c_x100 == -12700)
    decode.Chameleon_TempC = "NULL";
  else
    decode.Chameleon_TempC = parseFloat((soil_temp_c_x100 / 100).toFixed(2));

  decode.Chameleon_R1_Ohm_Comp = readChameleonResistance(bytes, 12, dataInvalid, decode.Chameleon_CH1_Open);
  decode.Chameleon_R2_Ohm_Comp = readChameleonResistance(bytes, 16, dataInvalid, decode.Chameleon_CH2_Open);
  decode.Chameleon_R3_Ohm_Comp = readChameleonResistance(bytes, 20, dataInvalid, decode.Chameleon_CH3_Open);
  decode.Chameleon_R1_Ohm_Raw = readChameleonResistance(bytes, 24, dataInvalid, decode.Chameleon_CH1_Open);
  decode.Chameleon_R2_Ohm_Raw = readChameleonResistance(bytes, 28, dataInvalid, decode.Chameleon_CH2_Open);
  decode.Chameleon_R3_Ohm_Raw = readChameleonResistance(bytes, 32, dataInvalid, decode.Chameleon_CH3_Open);
  decode.Chameleon_Array_ID = (dataInvalid || decode.Chameleon_ID_Fault) ? "NULL" : bytesToHex(bytes, 36, 8);
}

function Decode(fPort, bytes, variables) {
//LSN50 Decode   
if(fPort==0x02)
{
  var decode = {};
  var mode=(bytes[6] & 0x7C)>>2;
  
  decode.Digital_IStatus= (bytes[6] & 0x02)? "H":"L";
  
  if(mode!=2)
  {
    decode.BatV= (bytes[0]<<8 | bytes[1])/1000;
    if((bytes[2]==0x7f)&&(bytes[3]==0xff))
      decode.TempC1= "NULL";
    else
      decode.TempC1= parseFloat(((bytes[2]<<24>>16 | bytes[3])/10).toFixed(1));
    if(mode!=8)
      decode.ADC_CH0V= (bytes[4]<<8 | bytes[5])/1000;
  }
  
  if((mode!=5)&&(mode!=6))
  {
  	decode.EXTI_Trigger= (bytes[6] & 0x01)? "TRUE":"FALSE";
    decode.Door_status= (bytes[6] & 0x80)? "CLOSE":"OPEN";
  }
  
  if(mode=='0')
  {
    decode.Work_mode="IIC";
    if((bytes[9]<<8 | bytes[10])===0)
      decode.Illum= (bytes[7]<<8 | bytes[8]);
    else 
    {
      if(((bytes[7]==0x7f)&&(bytes[8]==0xff))||((bytes[7]==0xff)&&(bytes[8]==0xff)))
        decode.TempC_SHT= "NULL";
      else
        decode.TempC_SHT= parseFloat(((bytes[7]<<24>>16 | bytes[8])/10).toFixed(1));
  
      if((bytes[9]==0xff)&&(bytes[10]==0xff))
        decode.Hum_SHT= "NULL";
      else
        decode.Hum_SHT= parseFloat(((bytes[9]<<8 | bytes[10])/10).toFixed(1));
    }
  }
  else if(mode=='1')
  {
    decode.Work_mode="Distance";

    if((bytes[7]===0x00)&&(bytes[8]===0x00))
      decode.Distance_cm= "NULL";
    else
      decode.Distance_cm= parseFloat(((bytes[7]<<8 | bytes[8])/10).toFixed(1));
        
    if(!((bytes[9]==0xff)&&(bytes[10]==0xff)))
      decode.Distance_signal_strength= (bytes[9]<<8 | bytes[10]);
  }
  else if(mode=='2')
  {
    decode.Work_mode="3ADC+IIC";
    decode.ADC_CH0V= (bytes[0]<<8 | bytes[1])/1000;
    decode.ADC_CH1V= (bytes[2]<<8 | bytes[3])/1000;
    decode.ADC_CH4V= (bytes[4]<<8 | bytes[5])/1000;
    if(isChameleonV1Frame(bytes))
    {
      decode.BatV= bytes[7]/10;
      decodeChameleonV1(decode, bytes);
    }
    else
    {
      decode.BatV= bytes[11]/10;
      if((bytes[9]<<8 | bytes[10])===0)
        decode.Illum= (bytes[7]<<8 | bytes[8]);
      else
      {
        if(((bytes[7]==0x7f)&&(bytes[8]==0xff))||((bytes[7]==0xff)&&(bytes[8]==0xff)))
          decode.TempC_SHT= "NULL";
        else
          decode.TempC_SHT= parseFloat(((bytes[7]<<24>>16 | bytes[8])/10).toFixed(1));

        if((bytes[9]==0xff)&&(bytes[10]==0xff))
          decode.Hum_SHT= "NULL";
        else
          decode.Hum_SHT= parseFloat(((bytes[9]<<8 | bytes[10])/10).toFixed(1));
      }
    }
  }
  else if(mode=='3')
  {
    decode.Work_mode="3DS18B20";
    if((bytes[7]==0x7f)&&(bytes[8]==0xff))
      decode.TempC2= "NULL";
    else  
      decode.TempC2= parseFloat(((bytes[7]<<24>>16 | bytes[8])/10).toFixed(1));
      
    if((bytes[9]==0x7f)&&(bytes[10]==0xff))
      decode.TempC3= "NULL";  
    else
      decode.TempC3= parseFloat(((bytes[9]<<24>>16 | bytes[10])/10).toFixed(1));
  }
  else if(mode=='4')
  {
    decode.Work_mode="Weight";
    decode.Weight= (bytes[9]<<24 | bytes[10]<<16 | bytes[7]<<8 | bytes[8]);
  }
  else if(mode=='5')
  {
    decode.Work_mode="1Count";
    decode.Count= (bytes[7]<<24 | bytes[8]<<16 | bytes[9]<<8 | bytes[10])>>>0;
  }
  else if(mode=='6')
  {
    decode.Work_mode="3Interrupt";
    decode.EXTI1_Trigger= (bytes[6] & 0x01)? "TRUE":"FALSE";  
    decode.EXTI1_Status= (bytes[6] & 0x80)? "CLOSE":"OPEN"; 
    decode.EXTI2_Trigger= (bytes[7] & 0x10)? "TRUE":"FALSE";
    decode.EXTI2_Status= (bytes[7] & 0x01)? "CLOSE":"OPEN"; 
    decode.EXTI3_Trigger= (bytes[8] & 0x10)? "TRUE":"FALSE";
    decode.EXTI3_Status= (bytes[8] & 0x01)? "CLOSE":"OPEN";
  }
  else if(mode=='7')
  {
    decode.Work_mode="3ADC+1DS18B20";
    decode.ADC_CH1V= (bytes[7]<<8 | bytes[8])/1000;
    decode.ADC_CH4V= (bytes[9]<<8 | bytes[10])/1000;  
  }
  else if(mode=='8')
  {
    decode.Work_mode="3DS18B20+2Count";
    if((bytes[4]==0x7f)&&(bytes[5]==0xff))
      decode.TempC2= "NULL";
    else  
      decode.TempC2= parseFloat(((bytes[4]<<24>>16 | bytes[5])/10).toFixed(1));
      
    if((bytes[7]==0x7f)&&(bytes[8]==0xff))
      decode.TempC3= "NULL";  
    else
      decode.TempC3= parseFloat(((bytes[7]<<24>>16 | bytes[8])/10).toFixed(1));
      
    decode.Count1= (bytes[9]<<24 | bytes[10]<<16 | bytes[11]<<8 | bytes[12])>>>0;
    decode.Count2= (bytes[13]<<24 | bytes[14]<<16 | bytes[15]<<8 | bytes[16])>>>0;
  }
  decode.Node_type="LSN50";
  if(bytes.length!=1)
    return decode;
  }
  
  else if(fPort==5)
  {
  	var freq_band;
  	var sub_band;
  	
    if(bytes[0]==0x01)
        freq_band="EU868";
  	else if(bytes[0]==0x02)
        freq_band="US915";
  	else if(bytes[0]==0x03)
        freq_band="IN865";
  	else if(bytes[0]==0x04)
        freq_band="AU915";
  	else if(bytes[0]==0x05)
        freq_band="KZ865";
  	else if(bytes[0]==0x06)
        freq_band="RU864";
  	else if(bytes[0]==0x07)
        freq_band="AS923";
  	else if(bytes[0]==0x08)
        freq_band="AS923_1";
  	else if(bytes[0]==0x09)
        freq_band="AS923_2";
  	else if(bytes[0]==0x0A)
        freq_band="AS923_3";
  	else if(bytes[0]==0x0F)
        freq_band="AS923_4";
  	else if(bytes[0]==0x0B)
        freq_band="CN470";
  	else if(bytes[0]==0x0C)
        freq_band="EU433";
  	else if(bytes[0]==0x0D)
        freq_band="KR920";
  	else if(bytes[0]==0x0E)
        freq_band="MA869";
  	
    if(bytes[1]==0xff)
      sub_band="NULL";
	  else
      sub_band=bytes[1];

	  var firm_ver= (bytes[2]&0x0f)+'.'+(bytes[3]>>4&0x0f)+'.'+(bytes[3]&0x0f);
	  
	  var tdc_time= bytes[4]<<16 | bytes[5]<<8 | bytes[6];
	  
  	return {
      FIRMWARE_VERSION:firm_ver,
      FREQUENCY_BAND:freq_band,
      SUB_BAND:sub_band,
      TDC_sec:tdc_time,
  	}
  }
}
