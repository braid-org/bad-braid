var http = require('http')
var https = require('https')
var net = require('net')
var tls = require('tls')
var fs = require('fs')
var {Transform} = require('stream')
var {http_server: braidify} = require('braid-http')
var {WebSocketServer} = require('ws')

var wss = new WebSocketServer({noServer: true})

var port = process.argv[2] || 4000
var configs_file = 'configs.db'

// Load persisted configs or start fresh
var configs = {}
try { configs = JSON.parse(fs.readFileSync(configs_file, 'utf8')) } catch (e) {}

var subscribers = {}  // prefix -> [res, ...]
var versions = {}     // prefix -> number

function save_configs() {
    fs.writeFile(configs_file, JSON.stringify(configs, null, 2), () => {})
}

var default_config = {delay_ms: 0, loss_rate: 0, bandwidth_kbps: 0}

function get_config(prefix) {
    if (!configs[prefix]) configs[prefix] = {}
    var c = configs[prefix]
    for (var k in default_config)
        if (!(k in c)) c[k] = default_config[k]
    return c
}

function get_version(prefix) {
    if (!versions[prefix]) versions[prefix] = 0
    return ['' + versions[prefix]]
}

// Parse request path into prefix and target url
function parse_path(url) {
    var match = url.match(/^\/(.*?)((?:https?|wss?):\/\/.*)$/)
    if (match) {
        var prefix = match[1].replace(/\/$/, '')
        return {prefix, target: match[2]}
    }
    var prefix = url.replace(/^\//, '').replace(/\/$/, '')
    return {prefix, target: null}
}

// Degrades a TCP stream.
//
// This creates a FIFO queue of chunks.  Each chunk is stamped with a delivery
// time, and then drained in order with delays.  Creates Head-of-line
// blocking.
//
// Config:
//   delay_ms    — latency in each direction
//   loss_rate   — probability per chunk of a loss event (adds ~1 RTT retransmit delay)
//   bandwidth   — max kbps (0 = unlimited)
//
function degrade_stream(get_config) {
    var queue = []
    var timer = null
    var flush_cb = null
    var bandwidth_available_at = 0  // earliest time the pipe is free for next byte

    var t = new Transform({
        transform(chunk, enc, cb) {
            var config = get_config()
            var now = Date.now()

            // Latency: base one-way delay
            var delay = config.delay_ms || 0

            // Packet loss: retransmit penalty is ~1 RTT (2x one-way latency)
            var loss_rate = config.loss_rate || 0
            if (loss_rate > 0 && Math.random() < loss_rate)
                delay += 2 * (config.delay_ms || 0)

            // Bandwidth: time to transmit this chunk at max kbps
            var bw = config.bandwidth_kbps || 0
            if (bw > 0) {
                var transmit_ms = (chunk.length * 8) / bw
                bandwidth_available_at = Math.max(now, bandwidth_available_at) + transmit_ms
                var bw_delay = bandwidth_available_at - now
                delay = Math.max(delay, bw_delay)
            }

            queue.push({chunk, deliver_at: now + delay})
            if (!timer) schedule()
            cb()
        },
        flush(cb) {
            // When the stream ends, wait for queued chunks to drain before
            // finishing
            if (queue.length > 0) flush_cb = cb
            else cb()
        }
    })

    function schedule() {
        if (queue.length === 0) {
            timer = null
            if (flush_cb) flush_cb()
            return
        }
        var wait = Math.max(0, queue[0].deliver_at - Date.now())
        timer = setTimeout(() => {
            t.push(queue.shift().chunk)
            schedule()
        }, wait)
    }

    return t
}

// Headers that are per-hop and shouldn't be forwarded
var hop_by_hop = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade'
])

function forward_headers(raw_headers, overrides) {
    var headers = {}
    for (var key in raw_headers)
        if (!hop_by_hop.has(key.toLowerCase()) && !key.startsWith(':'))
            headers[key] = raw_headers[key]
    for (var key in overrides)
        headers[key] = overrides[key]
    return headers
}

// HTML landing/config page
function config_html(prefix) {
    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Bad Braid${prefix ? ' — /' + prefix : ''}</title>
  <style>
    body { font-family: monospace; max-width: 600px; margin: 40px auto; padding: 0 20px; color: #333 }
    h1 { font-weight: normal }
    p { line-height: 1.6 }
    label { display: block; margin: 20px 0; position: relative }
    input[type=range] { width: 300px }
    .val { position: absolute; left: 320px; top: 0 }
    code { background: #f4f4f4; padding: 2px 6px }
  </style>
</head>
<body>
  <h1>Bad Braid</h1>
  <p>Simulate a bad network. Prepend <code>https://bad.braid.org/</code> to any URL.</p>
  <p>For example: <code>https://bad.braid.org/https://your-site.com</code></p>
  ${prefix ? '<p>Prefix: <code>/' + prefix + '/</code></p>' : ''}

  <h2>Config${prefix ? ' for /' + prefix : ''}</h2>
  <div id="controls"></div>

  <script src="https://unpkg.com/braid-http/braid-http-client.js"></script>
  <script>
    var config = {}
    var peer = Math.random().toString(36).substr(2)

    async function connect() {
        var res = await braid_fetch(location.href, {
            subscribe: true,
            retry: true,
            peer: peer,
            headers: {Accept: 'application/json'}
        })
        res.subscribe(function (update) {
            config = JSON.parse(update.body_text)
            render()
        })
    }

    function render() {
        var el = document.getElementById('controls')
        el.innerHTML = ''
        for (var key in config) {
            var label = document.createElement('label')
            var val = config[key]
            var display = key === 'loss_rate' ? val.toFixed(2) : Math.round(val)
            label.innerHTML = key + ': <span class="val">' + display + '</span><br>'
            var input = document.createElement('input')
            input.type = 'range'
            input.min = 0
            input.max = key === 'delay_ms' ? 5000
                      : key === 'bandwidth_kbps' ? 10000
                      : key === 'loss_rate' ? 1
                      : 100
            input.step = key === 'loss_rate' ? 0.01 : 1
            input.value = val
            input.dataset.key = key
            input.oninput = function () {
                var k = this.dataset.key
                var v = k === 'loss_rate' ? Number(this.value) : Math.round(Number(this.value))
                config[k] = v
                this.parentNode.querySelector('.val').textContent = k === 'loss_rate' ? v.toFixed(2) : v
                send()
            }
            label.appendChild(input)
            el.appendChild(label)
        }
    }

    function send() {
        braid_fetch(location.href, {
            method: 'PUT',
            peer: peer,
            headers: {'Content-Type': 'application/json', Accept: 'application/json'},
            body: JSON.stringify(config)
        })
    }

    connect()
  </script>
</body>
</html>`
}

// Serve config as braid-synced json
function serve_config(req, res, prefix) {
    braidify(req, res)
    if (req.is_multiplexer) return

    var config = get_config(prefix)

    if (req.method === 'PUT') {
        var body = ''
        req.on('data', chunk => body += chunk)
        req.on('end', () => {
            try {
                configs[prefix] = JSON.parse(body)
                versions[prefix] = (versions[prefix] || 0) + 1
                save_configs()

                var sender_peer = req.headers.peer
                if (subscribers[prefix])
                    for (var sub of subscribers[prefix])
                        if (sub.peer !== sender_peer)
                            sub.sendUpdate({
                                version: get_version(prefix),
                                body: JSON.stringify(configs[prefix])
                            })

                res.writeHead(200)
                res.end()
            } catch (e) {
                res.writeHead(400)
                res.end('bad json')
            }
        })
        return
    }

    // GET
    res.setHeader('Content-Type', 'application/json')

    if (req.subscribe) {
        res.startSubscription({
            onClose: () => {
                if (subscribers[prefix])
                    subscribers[prefix] = subscribers[prefix].filter(s => s !== res)
            }
        })
        if (!subscribers[prefix]) subscribers[prefix] = []
        res.peer = req.headers.peer
        subscribers[prefix].push(res)
    }

    res.sendUpdate({
        version: get_version(prefix),
        body: JSON.stringify(config)
    })

    if (!req.subscribe)
        res.end()
}

// HTTP proxy with bidirectional delay
function proxy_http(req, res, prefix, target) {
    var url = new URL(target)
    var is_https = url.protocol === 'https:'

    var mod = is_https ? https : http
    var upstream = mod.request({
        hostname: url.hostname,
        port: url.port || (is_https ? 443 : 80),
        path: url.pathname + url.search,
        method: req.method,
        headers: forward_headers(req.headers, {host: url.host})
    })

    upstream.on('error', e => {
        console.log('proxy error:', e.code || e.message)
        if (!res.headersSent) res.writeHead(502)
        res.end('proxy error')
    })

    upstream.on('response', upstream_res => {
        var headers = forward_headers(upstream_res.headers, {})

        // Remember target origin in a cookie so websocket upgrades can find it
        var origin = new URL(target).origin
        var cookie = 'bad_braid=' + encodeURIComponent((prefix ? prefix + '/' : '') + origin) + '; Path=/; SameSite=Lax'
        var existing = headers['set-cookie']
        if (existing)
            headers['set-cookie'] = [].concat(existing, cookie)
        else
            headers['set-cookie'] = cookie

        res.writeHead(upstream_res.statusCode, headers)
        upstream_res
            .pipe(degrade_stream(() => get_config(prefix)))
            .pipe(res)
    })

    // Pipe request body through delay to upstream
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
        upstream.end()
    } else {
        req .pipe(degrade_stream(() => get_config(prefix)))
            .pipe(upstream)
    }
}

// WebSocket proxy with bidirectional delay.
// Uses the ws library for the client-side handshake (browsers require it),
// then detaches the raw socket and pipes it to the upstream through degrade_stream.
function proxy_ws(req, client_socket, head, prefix, target) {
    var url = new URL(target)
    var is_secure = url.protocol === 'wss:' || url.protocol === 'https:'
    var mod = is_secure ? https : http

    // Complete the websocket handshake with the client
    wss.handleUpgrade(req, client_socket, head, function (ws) {
        var raw = ws._socket

        // Detach ws from the socket so we can pipe raw bytes
        raw.removeAllListeners('data')
        raw.removeAllListeners('close')
        raw.removeAllListeners('end')

        // Connect to the upstream server
        var headers = forward_headers(req.headers, {host: url.host})
        headers.connection = 'Upgrade'
        headers.upgrade = 'websocket'

        var upstream_req = mod.request({
            hostname: url.hostname,
            port: url.port || (is_secure ? 443 : 80),
            path: (url.pathname || '/') + (url.search || ''),
            headers: headers
        })

        upstream_req.on('error', e => {
            console.log('ws upstream error:', e.code || e.message)
            raw.destroy()
        })
        raw.on('error', e => {
            console.log('ws client error:', e.code || e.message)
            upstream_req.destroy()
        })

        upstream_req.on('upgrade', (upstream_res, upstream_socket, upstream_head) => {
            if (upstream_head && upstream_head.length)
                upstream_socket.unshift(upstream_head)

            upstream_socket.on('error', e => {
                console.log('ws upstream socket error:', e.code || e.message)
                raw.destroy()
            })

            // Pipe bidirectionally with degradation
            raw .pipe(degrade_stream(() => get_config(prefix)))
                .pipe(upstream_socket)
            upstream_socket
                .pipe(degrade_stream(() => get_config(prefix)))
                .pipe(raw)
        })

        upstream_req.end()
    })
}

// Main server
var tls_options = null
try {
    tls_options = {
        key: fs.readFileSync('key.pem'),
        cert: fs.readFileSync('cert.pem'),
        allowHTTP1: true
    }
} catch (e) {}

var create_server = tls_options
    ? (handler) => require('http2').createSecureServer(tls_options, handler)
    : (handler) => http.createServer(handler)

var server = create_server(function (req, res) {
    var {prefix, target} = parse_path(req.url)

    // Split the path into the prefix, and the remote "target" URL we are proxying.

    // If there's no target in the URL, then there are two possibilities:
    //
    //  1. This is the configuration page for the prefix alone
    //  2. The actual page already loaded, and now is asking for its assets like /script.js
    //     to load.
    //
    // We have a crazy hack for case 2 -- we look for the referer header.  And
    // if that's present, we rewrite the URL for it. :)

    // Let's check case two first:
    if (!target) {
        // Try to recover target from referer header (handles /style.css loaded
        // from a page at /prefix/https://example.com/)
        var ref = req.headers.referer || req.headers.referrer
        if (ref) {
            var ref_parsed = parse_path(new URL(ref).pathname)
            if (ref_parsed.target) {
                var origin = new URL(ref_parsed.target).origin
                target = origin + req.url
                prefix = ref_parsed.prefix
            }
        }
    }

    // Otherwise, this is a configurator page.
    if (!target) {
        var accepts = req.headers.accept || ''
        if (accepts.includes('application/json') || accepts.includes('text/json'))
            return serve_config(req, res, prefix)

        res.writeHead(200, {'Content-Type': 'text/html'})
        res.end(config_html(prefix))
        return
    }

    proxy_http(req, res, prefix, target)
})

server.on('upgrade', function (req, socket, head) {
    var {prefix, target} = parse_path(req.url)

    // Recover target from cookie if not in the URL (e.g. new WebSocket('/ws'))
    if (!target) {
        var cookies = {}
        ;(req.headers.cookie || '').split(';').forEach(function (c) {
            var parts = c.trim().split('=')
            if (parts.length === 2) cookies[parts[0]] = decodeURIComponent(parts[1])
        })
        if (cookies.bad_braid) {
            var cookie_parsed = parse_path('/' + cookies.bad_braid)
            if (cookie_parsed.target) {
                var origin = new URL(cookie_parsed.target).origin
                target = origin + req.url
                prefix = cookie_parsed.prefix
            }
        }
    }

    if (!target) {
        console.log('ws: no target found, destroying')
        socket.destroy()
        return
    }
    proxy_ws(req, socket, head, prefix, target)
})

server.listen(port, () => console.log('bad braid on port', port, tls_options ? '(https/h2)' : '(http)'))
