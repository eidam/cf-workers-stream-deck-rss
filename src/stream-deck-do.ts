import { Router } from 'itty-router'
import { Env } from './types'

import {fromXML} from "from-xml";

export class StreamDeckDurableObject {
  state: DurableObjectState
  storage: DurableObjectStorage
  env: Env

  sessions: Array<any>
  contexts: Record<string, Array<string>>

  router: Router<any>

  constructor(state: DurableObjectState, env: Env) {
    this.state = state
    this.storage = state.storage
    this.env = env

    this.sessions = []

    const router = Router()
    router.get('/refresh', req => this.handleRefresh(req))
    router.all('/', req => this.handleWebsockets(req))
    this.router = router
  }

  async fetch(req: Request) {
    try {
      return this.router.handle(req)
    } catch (e) {
      return new Response(null, {status: 500})
    }
  }

  async handleRefresh(req) {
    //await this.storage.delete("items")
    const state = (await this.storage.get("items")) || []
    const rssFeedUrl = "https://blog.cloudflare.com/rss/"
    const data = fromXML(await (await fetch(rssFeedUrl)).text());

    const items = (await Promise.all(data.rss.channel.item.map(async item => {
      // fetch and update thumbnail
      const thumbnail = `https://eidam.tf/cdn-cgi/image/f=png,w=144,h=144,fit=crop,metadata=none/${item["media:content"]["@url"]}?format=png`
      const thumbnailBlob = (await (await fetch(thumbnail)).blob())
      // @ts-ignore
      const thumbnailDataUri = `data:image/png;base64,${btoa(String.fromCharCode(...new Uint8Array(await new Response(thumbnailBlob).arrayBuffer())))}`
      try {
        // @ts-ignore
        await this.env.KV_STREAMDECK.put(`thumbnail/${item.guid["#"]}`, thumbnailDataUri || undefined)
      } catch (e) {
        console.log("faled to save: ", thumbnail, e.toString())
      }

      // @ts-ignore
      const itemStateIndex = state.findIndex(x => x.guid === item.guid["#"])

      // create if not in the state
      if (itemStateIndex === -1) {
        return {guid: item.guid["#"], url: item.link, title: item.title, author: item["dc:creator"]}
      } else {
        // otherwise edit state (updated url/image)
        state[itemStateIndex].url = item.link
        state[itemStateIndex].title = item.title
        state[itemStateIndex].author = item["dc:creator"]
        return false
      }
      
    }))).filter(Boolean)
    
    // put new items at the start, and keep 32 only
    await this.storage.put(`items`, items.concat(state).slice(0, 31))
    this.broadcastRerender()
    return new Response('ok')
  }

  async handleWebsockets(req) {
    // @ts-ignore
    const pair = new WebSocketPair()

    // We're going to take pair[1] as our end, and return pair[0] to the client.
    await this.handleWebsocket(pair[1])

    // Now we return the other end of the pair to the client.
    // @ts-ignore
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  async handleWebsocket(webSocket) {
    // Accept our end of the WebSocket. This tells the runtime that we'll be terminating the
    // WebSocket in JavaScript, not sending it elsewhere.
    webSocket.accept()

    // Create our session and add it to the sessions list.
    let session = { webSocket, device: undefined, contexts: {}, markAsRead: false, contextData: new Map() }
    this.sessions.push(session)
  

    // On "close" and "error" events, remove the WebSocket from the sessions list and broadcast
    // a quit message.
    let closeOrErrorHandler = event => {
      // @ts-ignore
      session.quit = true
      this.sessions = this.sessions.filter(s => s !== session)
      this.broadcastRerender()
    }

    let messageHandler = async event => {
      const data = JSON.parse(event.data)
      const {event: wsEvent, device, payload, context} = data

      session.device = device

      if (wsEvent === "willAppear") {
        if (payload.settings.id === "blog_unread" || payload.settings.id === "blog_all") {
          const contextKey = `${device}/${payload.settings.id}`
          if (!session.contexts[contextKey])
          session.contexts[contextKey] = []
          if (!session.contexts[contextKey].includes(context))
          session.contexts[contextKey].splice(parseInt(`${payload.coordinates.row}${payload.coordinates.column}`), 0, context)

          if (payload.settings.id === "blog_all" && [5, 14, 31].includes(session.contexts[contextKey].length)) this.broadcastRerender()
          else if (payload.settings.id === "blog_unread" && [3, 10, 24].includes(session.contexts[contextKey].length)) {this.broadcastRerender()}
        } else if (payload.settings.id === "action") {
          messageSession(JSON.stringify({
            "event": "setState",
            "context": context,
            "payload": {
                "state": 0
            }
        }))
        }
      } else if (wsEvent === "keyDown" && payload.coordinates) {
        session.device = device

        if (payload.settings.id === "blog_unread" || payload.settings.id === "blog_all") {
          if (session.markAsRead) {
            const contextData = session.contextData.get(context)
            if (contextData) {
              
              let state = await this.storage.get(`${session.device}/blogs_read`) || []
              // @ts-ignore
              state.push(contextData.guid)
              await this.storage.put(`${session.device}/blogs_read`, state)
            }
          } else {
            messageSession(JSON.stringify({
              "event": "openUrl",
              "payload": {
                "url": session.contextData.get(context)?.url 
              }
            }))
          }
          messageSession(JSON.stringify({
            "event": "showOk",
            "context": context,
          }))
          this.broadcastRerender()
        } else if (payload.settings.id === "action") {
          session.markAsRead = !payload.state
        }
      } else {
        //console.log(data)
      }
    }

    let messageSession = (msg) => {
      session.webSocket.send(msg)
    }

    webSocket.addEventListener('close', closeOrErrorHandler)
    webSocket.addEventListener('error', closeOrErrorHandler)
    webSocket.addEventListener('message', messageHandler)
  }

  async broadcastRerender() {
    const items = await this.storage.get(`items`) || []
    this.sessions = this.sessions.filter(async (session) => {
      try {
        if (session.device) {

          // UPDATE ALL BLOGS
          session.contexts[`${session.device}/blog_all`]?.forEach(async (context, index) => {

              const item = items[index]
              session.contextData.set(context, item)

              session.webSocket.send(JSON.stringify({
                "event": "setTitle",
                "context": context,
                "payload": {
                    "title": item ? item.author : "",
                    "target": 0,
                }
              }))

              session.webSocket.send(JSON.stringify({
                "event": "setImage",
                "context": context,
                "payload": {
                  //  || await this.storage.get(`thumbnail/${item.guid}`) is fallback to old thumbnails storage, to be removed after ~15 new blog posts
                  // @ts-ignore
                  "image": item ? await this.env.KV_STREAMDECK.get(`thumbnail/${item.guid}`) || await this.storage.get(`thumbnail/${item.guid}`) : "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAJAAAACQAQAAAADPPd8VAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAAAmJLR0QAAd2KE6QAAAAHdElNRQflCgYUHiuGVKrfAAAAGklEQVRIx+3BMQEAAADCoPVPbQ0PoAAA4NcACrAAAT408p8AAAAldEVYdGRhdGU6Y3JlYXRlADIwMjEtMTAtMDZUMjA6MzA6MzcrMDA6MDAe5stRAAAAJXRFWHRkYXRlOm1vZGlmeQAyMDIxLTEwLTA2VDIwOjMwOjM3KzAwOjAwb7tz7QAAAABJRU5ErkJggg==",
                  "target": 0,
                }
              }))
          })

          session.contexts[`${session.device}/blog_unread`]?.forEach(async (context, index) => {
            const blogs_read = await this.storage.get(`${session.device}/blogs_read`) || []
            
            // @ts-ignore
            const item = items.filter(item => !blogs_read.includes(item.guid))[index]
            session.contextData.set(context, item)

            // update title
            session.webSocket.send(JSON.stringify({
              "event": "setTitle",
              "context": context,
              "payload": {
                  "title": item ? item.author : "",
                  "target": 0,
              }
            }))

            session.webSocket.send(JSON.stringify({
              "event": "setImage",
              "context": context,
              "payload": {
                //  || await this.storage.get(`thumbnail/${item.guid}`) is fallback to old thumbnails storage, to be removed after ~15 new blog posts
                // @ts-ignore
                "image": item ? await this.env.KV_STREAMDECK.get(`thumbnail/${item.guid}`) || await this.storage.get(`thumbnail/${item.guid}`) : "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAJAAAACQAQAAAADPPd8VAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAAAmJLR0QAAd2KE6QAAAAHdElNRQflCgYUHiuGVKrfAAAAGklEQVRIx+3BMQEAAADCoPVPbQ0PoAAA4NcACrAAAT408p8AAAAldEVYdGRhdGU6Y3JlYXRlADIwMjEtMTAtMDZUMjA6MzA6MzcrMDA6MDAe5stRAAAAJXRFWHRkYXRlOm1vZGlmeQAyMDIxLTEwLTA2VDIwOjMwOjM3KzAwOjAwb7tz7QAAAABJRU5ErkJggg==",
                "target": 0,
              }
            }))
          })
        }
        return true
      } catch (err) {
        session.quit = true
        return false
      }
    })
  }
}
