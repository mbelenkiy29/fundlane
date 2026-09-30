import { createServer } from "node:net"

// Next.js/fetch reject these SIP ports even when the OS considers them free.
const forbiddenPorts = new Set([5060, 5061])

export async function reserveLoopbackPort(createListener = createServer) {
  const reservations = []
  const release = async () => {
    await Promise.all(reservations.map(server => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    })))
  }
  try {
    for (;;) {
      const server = createListener()
      reservations.push(server)
      await new Promise((resolve, reject) => {
        server.once("error", reject)
        server.listen(0, "127.0.0.1", resolve)
      })
      const port = server.address().port
      if (!forbiddenPorts.has(port)) return { port, release }
    }
  } catch (error) {
    await release().catch(() => {})
    throw error
  }
}
