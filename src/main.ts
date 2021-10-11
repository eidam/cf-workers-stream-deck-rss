import { Router } from 'itty-router'
export { StreamDeckDurableObject } from './stream-deck-do'
import  {getDoStub} from './utils'

const router = Router()
router.all('*', (req, env) =>
  handleWebsockets(req, env),
)


export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env)
    } catch (e) {
      return new Response(e.message)
    }
  },

  async scheduled(controller, env, ctx) {
    const stub = getDoStub(env)
    return await stub.fetch("http://fake-host/refresh")
  },
}

async function handleRequest(req, env) {
  return router.handle(req, env)
}

async function handleWebsockets(req, env) {
  const stub = getDoStub(env)
  return await stub.fetch(req)
}
