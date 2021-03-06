'use strict'

const uuid = require('uuid/v4')

const BaseWs = require('./base-proxy-ws.js')
const Sock = require('./socket.js')

const Wallet = require('./wallet.js')
const Orders = require('./orders.js')
const Positions = require('./positions.js')

const BookScheduler = require('./bookscheduler.js')
const Book = require('./book.js')
const formatOrder = require('./hive-order-helper.js')

function _authPlugin (connId, msg, cb) {
  cb(null, { connId, data: msg })
}

class ProxyWs extends BaseWs {
  constructor (opts) {
    super(opts.ws)

    this.pairs = opts.pairs

    this.channels = {
      book: this.getBookChannels()
    }

    this.authUsers = {}

    this.authPlugin = opts.authPlugin || _authPlugin

    this.sock = new Sock({
      gateway: opts.endpoint
    })

    this.clients = {}

    this.bookScheduler = new BookScheduler({
      pairs: this.pairs,
      socket: this.sock
    })

    this.bookScheduler.updateBooks(this.handleBookUpdate.bind(this))
  }

  handleBookUpdate (_err, res) {
    const [pair, fullBook] = res

    const wsChannel = this.channels.book[pair]
    const book = wsChannel.book

    const msgs = book.update(fullBook)
    if (msgs.length === 0) return

    this.sendOrderbookUpdates(wsChannel, msgs)
  }

  getBookChannels () {
    const bookChannels = this.pairs.reduce((acc, el) => {
      const book = new Book({ pair: el })
      acc[el] = { id: book.chanId, clients: [], book: book }
      return acc
    }, {})

    return bookChannels
  }

  messageHook (ws, msg) {
    if (!msg) return

    if (msg.event) {
      return this.handleEvent(ws, msg)
    }

    if (Array.isArray(msg)) {
      return this.handleMessage(ws, msg)
    }
  }

  connectionHook (ws) {
    ws.id = uuid()
  }

  handleMessage (ws, msg) {
    if (msg[1] === 'on') {
      return this.sendOrder(ws, msg)
    }

    if (msg[1] === 'oc') {
      this.cancelOrder(ws, msg)
    }
  }

  handleEvent (ws, msg) {
    if (msg.event === 'subscribe') {
      this.subscribeBook(ws, msg)
    }

    if (msg.event === 'auth') {
      this.auth(ws, msg)
    }
  }

  auth (ws, msg) {
    const connId = ws.id

    this.authPlugin(connId, msg, (err, res) => {
      if (err) {
        return this.sendAuthError(ws)
      }

      const { id } = res.data

      const user = {
        id: +id,
        wallet: new Wallet(),
        orders: new Orders(),
        positions: new Positions()
      }

      this.authUsers[connId] = user

      this.subscribeUserdata(ws, id)
    })
  }

  getUserdata (userId, cb) {
    const payload = ['get_user_data', [+userId]]
    this.sendReqToHive(payload, cb)
  }

  sendReqToHive (payload, cb) {
    const reqId = uuid()
    payload.push(reqId)

    this.sock.send(reqId, 'gateway', payload, (err, res) => {
      if (err) {
        console.error(
          `request ${reqId} failed, payload: ${payload}, error:${err}`
        )
      }

      cb(err, res)
    })
  }

  subscribeUserdata (ws, id) {
    const connId = ws.id

    this.getUserdata(id, (err, res) => {
      if (err) return
      if (!this.authUsers[connId]) return

      res = res[0]
      if (res) {
        this.sendAuthUpdates(ws, connId, res)
      }

      if (!this.authUsers[connId]) return
      setTimeout(() => {
        this.subscribeUserdata(ws, id)
      }, 1500)
    })
  }

  sendAuthUpdates (ws, connId, data) {
    const user = this.authUsers[connId]
    if (!user) return

    const wallets = user.wallet.getMessages(data.wallets)
    const pos = user.positions.getMessages(data.positions)
    const orders = user.orders.getMessages(data.orders)
    ;[].concat(wallets, pos, orders).forEach((msg) => {
      this.send(ws, msg)
    })
  }

  subscribeBook (ws, msg) {
    const connId = ws.id

    const {
      symbol,
      channel
    } = msg

    if (!this.channels[channel]) {
      console.error('subscribeBook: malformed msg, missing channel:', channel)
      return
    }

    if (!this.channels[channel][symbol]) {
      console.error('subscribeBook: malformed msg, missing symbol:', symbol)
      return
    }

    const wsChannel = this.channels[channel][symbol]
    const channelId = wsChannel.id

    if (wsChannel.clients.includes(connId)) {
      return
    }

    wsChannel.clients.push(connId)

    this.send(ws, {
      event: 'subscribed',
      channel: 'book',
      chanId: channelId,
      symbol: symbol
    })

    this.send(ws, wsChannel.book.getSnapMessage())
  }

  getConnection (id) {
    let res = null

    // lookup in Set
    this.wss.clients.forEach((ws) => {
      if (ws.id === id) {
        res = ws
        return false
      }
    })

    return res
  }

  terminate (ws) {
    const connId = ws.id

    delete this.authUsers[connId]

    ws.terminate()
  }

  send (ws, msg) {
    try {
      ws.send(JSON.stringify(msg))
    } catch (e) {
      this.terminate(ws)
    }
  }

  sendAuthError (ws) {
    const err = { event: 'error', msg: 'user: invalid', code: 20000 }
    return this.send(ws, err)
  }

  cancelOrder (ws, payload) {
    const _cancel = payload[3]
    const connId = ws.id
    const authUser = this.authUsers[connId]

    if (!authUser) {
      this.sendAuthError(ws)
    }

    const msg = ['cancel_order', { 'id': _cancel.id, 'v_pair': _cancel.pair }]
    this.sendReqToHive(msg, (err, res) => {
      if (err) {
        this.sendAuthError(ws)
      }

      const inner = [
        _cancel.id,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        0,
        0,
        null,
        null,
        null,
        0,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null
      ]

      const ocn = [
        1538584137068,
        'oc-req',
        null,
        null,
        inner,
        null,
        'SUCCESS',
        'Submitted for cancellation; waiting for confirmation (ID: unknown).'
      ]

      this.send(ws, [0, 'n', ocn])
    })
  }

  async sendOrder (ws, payload) {
    const _order = payload[3]
    const connId = ws.id
    const authUser = this.authUsers[connId]

    if (!authUser) {
      const err = { event: 'error', msg: 'user: invalid', code: 20000 }
      return this.send(ws, err)
    }

    const reqId = uuid()
    const f = formatOrder({
      userId: authUser.id,
      ..._order
    })

    const msg = ['insert_order', f, reqId]
    try {
      await this.sock.send(reqId, 'gateway', msg)
    } catch (e) {
      console.error('insert_order request failed')
      console.error(e)

      if (e.message === 'ERR_BAL') {
        const err = {
          event: 'error',
          msg: 'order: insufficient balance',
          code: null
        }

        return this.send(ws, err)
      }

      const err = { event: 'error', msg: e.message || e.toString() }
      this.send(ws, err)
    }

    const te = [0, 'te', []]
    this.send(ws, te)
  }

  sendToSubscribed (wsChannel, msgs) {
    const clients = wsChannel.clients

    clients.forEach((connId) => {
      if (!this.authUsers[connId]) {
        const index = clients.indexOf(connId)
        if (index !== -1) {
          clients.splice(index, 1)
        }

        return
      }

      this.wss.clients.forEach((ws) => {
        if (ws.id === connId) {
          msgs.forEach((msg) => {
            this.send(ws, msg)
          })
        }
      })
    })
  }

  sendOrderbookUpdates (wsChannel, msgs) {
    this.sendToSubscribed(wsChannel, msgs)
  }
}

module.exports = ProxyWs
