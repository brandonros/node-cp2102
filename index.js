const Buffer = require('./node_modules/buffer/index').Buffer
const EventEmitter = require('./node_modules/events/events')
const usb = navigator.usb

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

  async getUsbDevice() {
    const device = await usb.requestDevice({
      filters: [
        {
          vendorId: VENDOR_ID,
          productId: PRODUCT_ID
        }
      ]
    })
    await device.open()
    const [ configuration ] = device.configurations
    if (device.configuration === null) {
      await device.selectConfiguration(configuration.configurationValue)
    }
    await device.claimInterface(configuration.interfaces[0].interfaceNumber)
    await device.selectAlternateInterface(configuration.interfaces[0].interfaceNumber, 0)
    return device
  }

  ifcEnable() {
    return this.device.controlTransferOut({
      requestType: 'vendor',
      recipient: 'device',
      request: CP210X_IFC_ENABLE,
      value: 0x01,
      index: 0x00
    }, Buffer.from([]))
  }

  setMhs() {
    return this.device.controlTransferOut({
      requestType: 'vendor',
      recipient: 'device',
      request: CP210X_SET_MHS,
      value: CONTROL_DTR | CONTROL_RTS | CONTROL_WRITE_DTR | CONTROL_WRITE_RTS,
      index: 0x00,
    }, Buffer.from([]))
  }

  setBaudDiv() {
    return this.device.controlTransferOut({
      requestType: 'vendor',
      recipient: 'device',
      request: CP210X_SET_BAUDDIV,
      value: BAUD_RATE_GEN_FREQ / this.serialRate,
      index: 0x00,
    }, Buffer.from([]))
  }

  reset() {
    const payload = Buffer.alloc(12)
    payload.writeUInt32LE(_CAN_RESET_ID, 0)
    const dataLen = 0x04
    const msgChan = 0xFF
    const msgFormat = 0x01
    const msgType = 0x01
    const frame = buildFrame(payload, dataLen, msgChan, msgFormat, msgType)
    return this.device.transferOut(this.outEndpoint.endpointNumber, frame)
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
    return this.device.transferOut(this.outEndpoint.endpointNumber, frame)
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
    return this.device.transferOut(this.outEndpoint.endpointNumber, frame)
  }

  sendCanFrame(arbitrationId, data) {
    console.debug(`sendCanFrame arbitrationId=${arbitrationId.toString(16)} data=${data.toString('hex')}`)
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
    return this.device.transferOut(this.outEndpoint.endpointNumber, frame)
  }

  async recv() {
    let buffer = Buffer.from([])
    for (;;) {
      const transferInResult = await this.device.transferIn(this.inEndpoint.endpointNumber, 64)
      const frame = Buffer.from(transferInResult.data.buffer)
      console.log(frame)
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
          const data = unescapedFrame.slice(4, 4 + dataLen)
          console.debug(`recv: arbitrationId=${arbitrationId.toString(16)} data=${data.toString('hex')}`)
          const output = Buffer.alloc(12)
          output.writeUInt32LE(arbitrationId, 0)
          data.copy(output, 4)
          this.emit('frame', output)
        }
      })
      buffer = buffer.slice(bytesProcessed)
    }
  }

  async init() {
    this.device = await this.getUsbDevice()
    this.inEndpoint = this.device.configuration.interfaces[0].alternates[0].endpoints.find(e => e.direction === 'in')
    this.outEndpoint = this.device.configuration.interfaces[0].alternates[0].endpoints.find(e => e.direction === 'out')
    await this.ifcEnable()
    await this.setMhs()
    await this.setBaudDiv()
    await this.reset()
    await this.setSerialRate()
    await this.setBitRate()
  }
}

module.exports = Cp2012
