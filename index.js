const usb = require('usb')
const util = require('util')
const EventEmitter = require('events')

const USB_DIR_OUT = 0
const USB_TYPE_VENDOR = (0x02 << 5)
const USB_RECIP_DEVICE = 0x00

const CP210X_IFC_ENABLE = 0x00
const CP210X_SET_MHS = 0x07
const CP210X_SET_BAUDDIV = 0x01
const BAUD_RATE_GEN_FREQ = 0x384000
const CONTROL_WRITE_RTS = 0x0200
const CONTROL_WRITE_DTR = 0x0100
const CONTROL_DTR = 0x01
const CONTROL_RTS = 0x02

const _PACKET_ESC = 0xA5
const _PACKET_HEAD = 0xAA
const _PACKET_TAIL = 0x55

const _CAN_RESET_ID = 0x01FFFEC0
const _CAN_SERIALBPS_ID = 0x01FFFE90
const _CAN_BAUD_ID = 0x01FFFED0

const PRODUCT_ID = 0xEA60
const VENDOR_ID = 0x10C4

const calculateChecksum = (input) => {
  let checksum = 0
  for (let i = 0; i < 16; ++i) {
     checksum = (checksum + input[i]) & 0xFF
  }
  return checksum
}

const escapeInput = (input) => {
  const output = []
  for (let i = 0; i < input.length; ++i) {
    if (input[i] === _PACKET_ESC || input[i] === _PACKET_HEAD || input[i] === _PACKET_TAIL) {
      output.push(_PACKET_ESC)
    }
    output.push(input[i])
  }
  return output
}

const unescapeInput = (input) => {
  const output = []
  for (let i = 0; i < input.length; ++i) {
    if (input[i] === _PACKET_ESC) {
      continue
    }
    output.push(input[i])
  }
  return output
}

const buildFrame = (payload, dataLen, msgChan, msgFormat, msgType) => {
  const checksumInput = [
     payload[0],
     payload[1],
     payload[2],
     payload[3],
     payload[4],
     payload[5],
     payload[6],
     payload[7],
     payload[8],
     payload[9],
     payload[10],
     payload[11],
     dataLen,
     msgChan,
     msgFormat,
     msgType
  ]
  const checksum = calculateChecksum(checksumInput)
  return Buffer.from([].concat(
     [_PACKET_HEAD, _PACKET_HEAD],
     escapeInput(checksumInput),
     [checksum],
     [_PACKET_TAIL, _PACKET_TAIL]
  ))
}

const processBuffer = (buffer, cb) => {
  let state = 'EXPECTING_HEADER'
  let i = 0
  let bytesProcessed = 0
  let payload = []
  while (i < buffer.length) {
    if (state === 'EXPECTING_HEADER') {
      if (buffer[i] !== _PACKET_HEAD || buffer[i + 1] !== _PACKET_HEAD) {
        break
      }
      i += 2
      state = 'READING_PAYLOAD'
    } else if (state === 'READING_PAYLOAD') {
      if (buffer[i] === _PACKET_TAIL && buffer[i + 1] === _PACKET_TAIL) {
        cb(Buffer.from(payload))
        payload = []
        i += 2
        bytesProcessed = i
        state = 'EXPECTING_HEADER'
      } else {
        payload.push(buffer[i])
        i += 1
      }
    }
  }
  return bytesProcessed
}

class Cp2012 extends EventEmitter {
  constructor(serialRate, bitRate) {
    super()
    this.serialRate = serialRate || 115200
    this.bitRate = bitRate || 1000000
  }

  getUsbDevice() {
    const deviceList = usb.getDeviceList()
    const device = deviceList.find(device => {
      return device.deviceDescriptor.idProduct === PRODUCT_ID &&
        device.deviceDescriptor.idVendor === VENDOR_ID
    })
    if (!device) {
      throw new Error('Device not found')
    }
    device.open()
    device.interfaces[0].claim()
    return device
  }

  ifcEnable() {
    return util.promisify(this.device.controlTransfer)(
      USB_DIR_OUT | USB_TYPE_VENDOR | USB_RECIP_DEVICE,
      CP210X_IFC_ENABLE,
      0x00,
      0x01,
      Buffer.from([])
    )
  }

  setMhs() {
    return util.promisify(this.device.controlTransfer)(
      USB_DIR_OUT | USB_TYPE_VENDOR | USB_RECIP_DEVICE,
      CP210X_SET_MHS,
      0x00,
      CONTROL_DTR | CONTROL_RTS | CONTROL_WRITE_DTR | CONTROL_WRITE_RTS,
      Buffer.from([])
    )
  }

  setBaudDiv() {
    return util.promisify(this.device.controlTransfer)(
      USB_DIR_OUT | USB_TYPE_VENDOR | USB_RECIP_DEVICE,
      CP210X_SET_BAUDDIV,
      0x00,
      BAUD_RATE_GEN_FREQ / this.serialRate,
      Buffer.from([])
    )
  }

  reset() {
    const payload = Buffer.alloc(12)
    payload.writeUInt32LE(_CAN_RESET_ID, 0)
    const dataLen = 0x04
    const msgChan = 0xFF
    const msgFormat = 0x01
    const msgType = 0x01
    const frame = buildFrame(payload, dataLen, msgChan, msgFormat, msgType)
    return util.promisify(this.outEndpoint.transfer)(frame)
  }

  setSerialRate() {
    const payload = Buffer.alloc(12)
    payload.writeUInt32LE(_CAN_SERIALBPS_ID, 0)
    payload.writeUInt32LE(this.serialRate, 4)
    const dataLen = 0x04
    const msgChan = 0xFF
    const msgFormat = 0x01
    const msgType = 0x01
    const frame = buildFrame(payload, dataLen, msgChan, msgFormat, msgType)
    return util.promisify(this.outEndpoint.transfer)(frame)
  }

  setBitRate() {
    const payload = Buffer.alloc(12)
    payload.writeUInt32LE(_CAN_BAUD_ID, 0)
    payload.writeUInt32LE(this.bitRate, 4)
    const dataLen = 0x04
    const msgChan = 0xFF
    const msgFormat = 0x01
    const msgType = 0x01
    const frame = buildFrame(payload, dataLen, msgChan, msgFormat, msgType)
    return util.promisify(this.outEndpoint.transfer)(frame)
  }

  sendCanFrame(arbitrationId, data) {
    const payload = Buffer.alloc(12)
    payload.writeUInt32LE(arbitrationId, 0)
    payload.writeUInt8(data[0], 4)
    payload.writeUInt8(data[1], 5)
    payload.writeUInt8(data[2], 6)
    payload.writeUInt8(data[3], 7)
    payload.writeUInt8(data[4], 8)
    payload.writeUInt8(data[5], 9)
    payload.writeUInt8(data[6], 10)
    payload.writeUInt8(data[7], 11)
    const dataLen = 0x08
    const msgChan = 0x00
    const msgFormat = 0x00
    const msgType = 0x00
    const frame = buildFrame(payload, dataLen, msgChan, msgFormat, msgType)
    return util.promisify(this.outEndpoint.transfer)(frame)
  }

  async recv() {
    let buffer = Buffer.from([])
    for (;;) {
      const frame = await util.promisify(this.inEndpoint.transfer)(64)
      buffer = Buffer.concat([buffer, frame])
      const bytesProcessed = processBuffer(buffer, (frame) => {
        const checksum = frame[frame.length - 1]
        const msgType = frame[frame.length - 2]
        const msgFormat = frame[frame.length - 3]
        const msgChan = frame[frame.length - 4]
        const dataLen = frame[frame.length - 5]
        if (dataLen === 0x08 && msgChan === 0x00 && msgFormat === 0x00 && msgType === 0x00) {
          const unescapedFrame = Buffer.from(unescapeInput(frame))
          const arbitrationId = unescapedFrame.readUInt32LE(0)
          const payload = unescapedFrame.slice(4, 4 + dataLen)
          this.emit('frame', {
            arbitrationId,
            payload
          })
        }
      })
      buffer = buffer.slice(bytesProcessed)
    }
  }

  async init() {
    this.device = this.getUsbDevice()
    this.inEndpoint = this.device.interfaces[0].endpoints.find(endpoint => endpoint.constructor.name === 'InEndpoint')
    this.outEndpoint = this.device.interfaces[0].endpoints.find(endpoint => endpoint.constructor.name === 'OutEndpoint')
    await this.ifcEnable()
    await this.setMhs()
    await this.setBaudDiv()
    await this.reset()
    await this.setSerialRate()
    await this.setBitRate()
  }
}

module.exports = Cp2012
