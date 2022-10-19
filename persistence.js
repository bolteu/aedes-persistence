const { Readable } = require('stream')
const QlobberSub = require('qlobber/aedes/qlobber-sub')
const { QlobberTrue, Qlobber } = require('qlobber')
const Packet = require('aedes-packet')
const QlobberOpts = {
  wildcard_one: '+',
  wildcard_some: '#',
  separator: '/'
}
const CREATE_ON_EMPTY = true

function * multiIterables (iterables) {
  for (const iter of iterables) {
    yield * iter
  }
}

function * retainedMessagesByPattern (retained, pattern) {
  const qlobber = new QlobberTrue(QlobberOpts)
  qlobber.add(pattern)

  for (const [topic, packet] of retained) {
    if (qlobber.test(topic)) {
      yield packet
    }
  }
}

function * willsByBrokers (wills, brokers) {
  for (const will of wills.values()) {
    if (!brokers[will.brokerId]) {
      yield will
    }
  }
}

function * clientListbyTopic (subscriptions, topic) {
  for (const [clientId, topicMap] of subscriptions) {
    if (topicMap.has(topic)) {
      yield clientId
    }
  }
}

class MemoryPersistence {
  // private class members start with #
  #retained
  #subscriptions
  #sharedTopics
  #sharedTopicsToGroups
  #sharedGroupsClientTopics
  #outgoing
  #incoming
  #wills
  #clientsCount
  #trie
  #trieShared

  constructor () {
    // using Maps for convenience and security (risk on prototype polution)
    // Map ( topic -> packet )
    this.#retained = new Map()
    // Map ( clientId -> Map( topic -> { qos, rh, rap, nl } ))
    this.#subscriptions = new Map()

    // Set ( topics )
    this.#sharedTopics = new Set()
    // Map ( topic -> Set( groups ))
    this.#sharedTopicsToGroups = new Map()
    // Map ( group -> Set( client_id_topic ))
    this.#sharedGroupsClientTopics = new Map()

    // Map ( clientId  > [ packet ] }
    this.#outgoing = new Map()
    // Map ( clientId -> { packetId -> Packet } )
    this.#incoming = new Map()
    // Map( clientId -> will )
    this.#wills = new Map()
    this.#clientsCount = 0
    this.#trie = new QlobberSub(QlobberOpts)
    this.#trieShared = new Qlobber(QlobberOpts)
  }

  storeRetained (pkt, cb) {
    const packet = Object.assign({}, pkt)
    if (packet.payload.length === 0) {
      this.#retained.delete(packet.topic)
    } else {
      this.#retained.set(packet.topic, packet)
    }
    cb(null)
  }

  createRetainedStreamCombi (patterns) {
    const iterables = patterns.map((p) => {
      return retainedMessagesByPattern(this.#retained, p)
    })
    return Readable.from(multiIterables(iterables))
  }

  createRetainedStream (pattern) {
    return Readable.from(retainedMessagesByPattern(this.#retained, pattern))
  }

  addSubscriptions (client, subs, cb) {
    let stored = this.#subscriptions.get(client.id)
    const trie = this.#trie

    if (!stored) {
      stored = new Map()
      this.#subscriptions.set(client.id, stored)
      this.#clientsCount++
    }

    for (const sub of subs) {
      const storedSub = stored.get(sub.topic)
      if (sub.qos > 0) {
        trie.add(sub.topic, {
          clientId: client.id,
          topic: sub.topic,
          qos: sub.qos,
          rh: sub.rh,
          rap: sub.rap,
          nl: sub.nl
        })
      } else if (storedSub?.qos > 0) {
        trie.remove(sub.topic, {
          clientId: client.id,
          topic: sub.topic
        })
      }
      stored.set(sub.topic, { qos: sub.qos, rh: sub.rh, rap: sub.rap, nl: sub.nl })
    }

    cb(null, client)
  }

  removeSubscriptions (client, subs, cb) {
    const stored = this.#subscriptions.get(client.id)
    const trie = this.#trie

    if (stored) {
      for (const topic of subs) {
        const storedSub = stored.get(topic)
        if (storedSub !== undefined) {
          if (storedSub.qos > 0) {
            trie.remove(topic, { clientId: client.id, topic })
          }
          stored.delete(topic)
        }
      }

      if (stored.size === 0) {
        this.#clientsCount--
        this.#subscriptions.delete(client.id)
      }
    }

    cb(null, client)
  }

  subscriptionsByClient (client, cb) {
    let subs = null
    const stored = this.#subscriptions.get(client.id)
    if (stored) {
      subs = []
      for (const [topic, storedSub] of stored) {
        subs.push({ topic, ...storedSub })
      }
    }
    cb(null, subs, client)
  }

  countOffline (cb) {
    return cb(null, this.#trie.subscriptionsCount, this.#clientsCount)
  }

  subscriptionsByTopic (pattern, cb) {
    cb(null, this.#trie.match(pattern))
  }

  cleanSubscriptions (client, cb) {
    const trie = this.#trie
    const stored = this.#subscriptions.get(client.id)

    if (stored) {
      for (const [topic, storedSub] of stored) {
        if (storedSub.qos > 0) {
          trie.remove(topic, { clientId: client.id, topic })
        }
      }

      this.#clientsCount--
      this.#subscriptions.delete(client.id)
    }

    cb(null, client)
  }

  #outgoingEnqueuePerSub (sub, packet) {
    const id = sub.clientId
    const queue = getMapRef(this.#outgoing, id, [], CREATE_ON_EMPTY)
    queue[queue.length] = new Packet(packet)
  }

  outgoingEnqueue (sub, packet, cb) {
    this.#outgoingEnqueuePerSub(sub, packet)
    process.nextTick(cb)
  }

  outgoingEnqueueCombi (subs, packet, cb) {
    for (let i = 0; i < subs.length; i++) {
      this.#outgoingEnqueuePerSub(subs[i], packet)
    }
    process.nextTick(cb)
  }

  outgoingUpdate (client, packet, cb) {
    const outgoing = getMapRef(this.#outgoing, client.id, [], CREATE_ON_EMPTY)

    let temp
    for (let i = 0; i < outgoing.length; i++) {
      temp = outgoing[i]
      if (temp.brokerId === packet.brokerId) {
        if (temp.brokerCounter === packet.brokerCounter) {
          temp.messageId = packet.messageId
          return cb(null, client, packet)
        }
        /*
                Maximum of messageId (packet identifier) is 65535 and will be rotated,
                brokerCounter is to ensure the packet identifier be unique.
                The for loop is going to search which packet messageId should be updated
                in the #outgoing queue.
                If there is a case that brokerCounter is different but messageId is same,
                we need to let the loop keep searching
                */
      } else if (temp.messageId === packet.messageId) {
        outgoing[i] = packet
        return cb(null, client, packet)
      }
    }

    cb(new Error('no such packet'), client, packet)
  }

  outgoingClearMessageId (client, packet, cb) {
    const outgoing = getMapRef(this.#outgoing, client.id, [], CREATE_ON_EMPTY)

    let temp
    for (let i = 0; i < outgoing.length; i++) {
      temp = outgoing[i]
      if (temp.messageId === packet.messageId) {
        outgoing.splice(i, 1)
        return cb(null, temp)
      }
    }

    cb()
  }

  outgoingStream (client) {
    // shallow clone the outgoing queue for this client to avoid race conditions
    const outgoing = [].concat(getMapRef(this.#outgoing, client.id, []))
    return Readable.from(outgoing)
  }

  incomingStorePacket (client, packet, cb) {
    const id = client.id
    const store = getMapRef(this.#incoming, id, {}, CREATE_ON_EMPTY)

    store[packet.messageId] = new Packet(packet)
    store[packet.messageId].messageId = packet.messageId

    cb(null)
  }

  incomingGetPacket (client, packet, cb) {
    const id = client.id
    const store = getMapRef(this.#incoming, id, {})
    let err = null

    this.#incoming.set(id, store)

    if (!store[packet.messageId]) {
      err = new Error('no such packet')
    }

    cb(err, store[packet.messageId])
  }

  incomingDelPacket (client, packet, cb) {
    const id = client.id
    const store = getMapRef(this.#incoming, id, {})
    const toDelete = store[packet.messageId]
    let err = null

    if (!toDelete) {
      err = new Error('no such packet')
    } else {
      delete store[packet.messageId]
    }

    cb(err)
  }

  putWill (client, packet, cb) {
    packet.brokerId = this.broker.id
    packet.clientId = client.id
    this.#wills.set(client.id, packet)
    cb(null, client)
  }

  getWill (client, cb) {
    cb(null, this.#wills.get(client.id), client)
  }

  delWill (client, cb) {
    const will = this.#wills.get(client.id)
    this.#wills.delete(client.id)
    cb(null, will, client)
  }

  streamWill (brokers = {}) {
    return Readable.from(willsByBrokers(this.#wills, brokers))
  }

  getClientList (topic) {
    return Readable.from(clientListbyTopic(this.#subscriptions, topic))
  }

  buildClientSharedTopic (group, clientId) {
    return `$share/${group}/$client_${clientId}/`
  }

  parseSharedTopic (topic) {
    if (!topic || !topic.startsWith('$share/')) return null

    const groupEndIndx = topic.indexOf('/', 7)
    if (groupEndIndx === -1) {
      return null
    }
    const group = topic.substring(7, groupEndIndx)
    const clientIndx = topic.indexOf('/$client_', groupEndIndx)
    if (clientIndx === -1) {
      return {
        group,
        client_id: null,
        topic: topic.substring(8 + group.length)
      }
    }
    const clientEndIndx = topic.indexOf('/', clientIndx + 9)
    const clientId = topic.substring(clientIndx + 9, clientEndIndx)
    const topicItself = topic.substring(clientEndIndx + 1, topic.length)

    return {
      group,
      client_id: clientId,
      topic: topicItself
    }
  }

  storeSharedSubscription (topic, group, clientId, cb) {
    const groupTopicKey = group + '_' + topic
    const clientTopic = this.buildClientSharedTopic(group, clientId)
    this.#sharedTopics.add(topic)
    this.#trieShared.add(topic, topic)
    const topicToGroup = this.#sharedTopicsToGroups.get(topic) ?? new Set()
    topicToGroup.add(groupTopicKey)
    this.#sharedTopicsToGroups.set(topic, topicToGroup)
    const groupClients = this.#sharedGroupsClientTopics.get(groupTopicKey) ?? new Set()
    groupClients.add(clientTopic)
    this.#sharedGroupsClientTopics.set(groupTopicKey, groupClients)
    cb(null, clientTopic + topic)
  }

  removeSharedSubscription (topic, group, clientId, cb) {
    const groupTopicKey = group + '_' + topic
    const clientTopic = this.buildClientSharedTopic(group, clientId)
    const groupClients = this.#sharedGroupsClientTopics.get(groupTopicKey)
    if (groupClients && groupClients.size !== 0) {
      groupClients.delete(clientTopic)
      if (groupClients.size === 0) {
        const groupsToTopics = this.#sharedTopicsToGroups.get(topic)
        if (groupsToTopics && groupsToTopics.size !== 0) {
          groupsToTopics.delete(groupTopicKey)
          if (groupsToTopics.size === 0) {
            this.#sharedTopics.delete(topic)
            this.#trieShared.remove(topic)
          }
        }
      }
    }
    cb()
  }

  getSharedTopics (topic, cb) {
    const resultTopics = []
    const matches = this.#trieShared.match(topic)
    for (const match of matches) {
      if (this.#sharedTopics.has(match)) {
        const groups = this.#sharedTopicsToGroups.get(match)
        for (const group of groups) {
          const clientTopics = Array.from(this.#sharedGroupsClientTopics.get(group))
          const randomTopic = clientTopics[Math.floor(Math.random() * clientTopics.length)]
          resultTopics.push(randomTopic + topic)
        }
      }
    }
    cb(null, resultTopics)
  }

  restoreOriginalTopicFromSharedOne (topic) {
    if (topic.startsWith('$share/') && topic.includes('/$client_')) {
      // extracting $share/group/$client_client_id from topic
      const originTopicIndex = topic.indexOf('/', topic.indexOf('/', 7) + 1)
      return topic.substring(originTopicIndex + 1, topic.length)
    }

    return topic
  }

  destroy (cb) {
    this.#retained = null
    if (cb) {
      cb(null)
    }
  }
}

function getMapRef (map, key, ifEmpty, createOnEmpty = false) {
  const value = map.get(key)
  if (value === undefined && createOnEmpty) {
    map.set(key, ifEmpty)
  }
  return value || ifEmpty
}

module.exports = () => { return new MemoryPersistence() }
module.exports.Packet = Packet
