const Cp2102 = require('../index')
document.querySelector('#go').addEventListener('click', async (event) => {
  const cp2102 = new Cp2102()
  await cp2102.init()
  await cp2102.recv()
})
