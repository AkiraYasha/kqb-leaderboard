const KQB_API_URL = 'wss://live-*************.ws.gamesparks.net/ws/player/*************'
const KQB_API_SECRET = '***********************'
const DEVICE_ID = '*************'
const DEVICE_OS = 'WINDOWS'
const DISCORD_USER_ID = '*********************'
const DISCORD_ACCESS_TOKEN = '************************'
const BUCKET_SIZE = 25


const fs = require('fs')
const crypto = require('crypto')
const WebSocket = require('ws')
const { EventEmitter } = require('events')
const jstat = require('jstat')
const debug = require('debug')('kqb')

class GameSparks extends EventEmitter {
    requests = {}
    connected = false

    constructor() {
        super()
    }

    connect() {
        this.connectToUrl(KQB_API_URL)

        return new Promise((resolve, reject) => {
            if (this.connected) {
                resolve()
            } else {
                this.on('connected', resolve)
                this.on('error', reject)
            }    
        })
    }

    connectToUrl(url) {
        if (this.ws) {
            this.ws.close()
        }

        this.ws = new WebSocket(url)

        this.ws.on('message', (data) => this.handleResponse(data))    
        this.ws.on('open', async () => this.handleOpen())
        this.ws.on('close', () => this.handleClose())
    }

    async disconnect() {
        const data = await this.send({
            '@class': '.EndSessionRequest',
        })

        this.ws.close()
    }

    async handleOpen() {
        debug('Connection Opened')
    }

    async handleClose() {
        this.connected = false
    }

    async handshake(data) {
        if (data.error) {
            this.ws.close()
            this.emit('error', error)
            return
        }

        if (data.nonce) {
            const hmac = crypto.createHmac('sha256', KQB_API_SECRET)
            hmac.update(data.nonce)
    
            this.sendInternal({
                '@class': '.AuthenticatedConnectRequest',
                'hmac': hmac.digest('base64'),
                'os': DEVICE_OS,
                'platform': 'WindowsPlayer',
                'deviceId': DEVICE_ID
            })
        }
        if (data.sessionId) {
            try {
                const response = await this.send({
                    "@class": ".DeviceAuthenticationRequest",
                    "deviceId": DISCORD_USER_ID,
                    "deviceOS": "discord",
                    "deviceType": "Desktop",
                    "operatingSystem": "WindowsPlayer",
                    "scriptData": {
                        "discordUserId": DISCORD_USER_ID,
                        "discordToken": DISCORD_ACCESS_TOKEN,
                    }
                })

                this.profile = response.scriptData.profile
                this.connected = true
                this.emit('connected')
            } catch (error) {
                this.ws.close()
                this.emit('error', error)
            }
        }
    }

    handleResponse(data) {
        data = JSON.parse(data)
        debug('<- %o', data)

        if (data.connectUrl) {
            this.connectToUrl(data.connectUrl)
            return
        }
        if (data['@class'] === '.AuthenticatedConnectResponse') {
            this.handshake(data)
            return
        }

        if (data['@class'].endsWith('Response')) {
            const handler = this.requests[data.requestId]
            if (handler) {
                data.error ? handler.reject(data) : handler.resolve(data)
                delete this.requests[data.requestId]
            }
        }
    }

    send(payload) {
        return new Promise((resolve, reject) => {
            const requestId = new Date().getTime()

            this.requests[requestId] = { resolve, reject }
            
            payload.requestId = requestId
            this.sendInternal(payload)
        })
    }

    sendInternal(payload) {
        debug('-> %o', payload)
        this.ws.send(JSON.stringify(payload, null, 2))
    }
}

function rank(v) {
    return [
        v < 1600 ? 1 : 0,
        v >= 1600 && v < 1800 ? 1 : 0,
        v >= 1800 && v < 2000 ? 1 : 0,
        v >= 2000 && v < 2200 ? 1 : 0,
        v >= 2200 ? 1 : 0,
    ]
}

async function fetchLeaderboard() {
    const gs = new GameSparks()
    await gs.connect()

    const response = await gs.send({
        '@class': '.LeaderboardDataRequest',
        'leaderboardShortCode': 'GLB',
        'entryCount': 10000
    })

    await gs.disconnect()

    const data = []

    let i = 0;
    for (const item of response.data) {
        data.push({
            name: item.userName.replace(/[^\x00-\x7F]/g, ""),
            league: item.league,
            rank: item.rank,
            score: item.CurrentScore,
            matches: (item.Wins + item.Loses),
            wins: item.Wins,
            loses: item.Loses,
            wp: item.Wins / (item.Wins + item.Loses)
        })
    }

    return data
}

function computeGraph(data) {
    const scores = data.map(d => d.score)
    const count = scores.length

    const mean = jstat.mean(scores)
    const stdev = jstat.stdev(scores)

    const minBucket = Math.floor((jstat.min(scores) + 1) / BUCKET_SIZE) * BUCKET_SIZE - 50
    const maxBucket = Math.ceil((jstat.max(scores) + 1) / BUCKET_SIZE) * BUCKET_SIZE + 50

    const result = [
        ['Bucket', 'Normal Distribution', 'Histogram', 'Bronze', 'Silver', 'Gold', 'Platinum', 'Obsidian']
    ]

    for (let bin = minBucket; bin <= maxBucket; bin += BUCKET_SIZE) {
        const pdf = jstat.normal.pdf(bin, mean, stdev)
        const nd = pdf * BUCKET_SIZE * count
        const hist = scores.filter(v => v >= bin && v <= bin + BUCKET_SIZE).length

        result.push([String(bin), nd, hist, ...rank(bin)])
    }

    return result
}

function renderOutput(data) {
    const template = fs.readFileSync('output.html.tmpl', 'UTF-8')
    const rendered = template.replace('%%DATA%%', JSON.stringify(data))
    fs.writeFileSync('index.html', rendered, 'UTF-8')
}


async function main() {
    const leaderboard = await fetchLeaderboard()
    const data = computeGraph(leaderboard)

    renderOutput(data)
}    


main().catch(error => {
    console.log('Unhandled Error')
    console.error(error)
})
