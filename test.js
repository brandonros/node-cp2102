const proxyquire = require('proxyquire')

let inTransferIndex = 0
const inTransferMocks = [
  Buffer.from('AAAA11223344070011223344A5556608000000005555', 'hex')
]

const claim = () => {

}

const open = () => {

}

const controlTransfer = (bmRequestType, bRequest, wValue, wIndex, data, cb) => {
  cb(null, undefined)
}

class InEndpoint {
  constructor() {

  }

  transfer(length, cb) {
    if (inTransferMocks[inTransferIndex]) {
      setTimeout(() => {
        cb(null, inTransferMocks[inTransferIndex])
        inTransferIndex += 1
      }, 1000)
    }
  }
}

class OutEndpoint {
  constructor() {

  }

  transfer(frame, cb) {
    console.log(frame)
    cb(null, undefined)
  }
}

const getDeviceList = () => {
  return [
    {
      deviceDescriptor: {
        idProduct: 0xEA60,
        idVendor: 0x10C4
      },
      controlTransfer,
      interfaces: [
        {
          claim,
          endpoints: [
            new InEndpoint(),
            new OutEndpoint()
          ]
        }
      ],
      open
    }
  ]
}

const Cp2012 = proxyquire('./index.js', {
  usb: {
    getDeviceList
  }
})

const run = async () => {
  const cp2012 = new Cp2012(115200, 1000000)
  cp2012.on('frame', (frame) => {
    console.log(frame)
  })
  await cp2012.init()
  cp2012.sendCanFrame(0x11223344, Buffer.from('0700112233445566', 'hex'))
  cp2012.recv()
  await new Promise(resolve => setTimeout(resolve, 1000))
}

run()