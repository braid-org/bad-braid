var http = require('http')
var https = require('https')
var net = require('net')
var tls = require('tls')
var fs = require('fs')
var {Transform} = require('stream')
var {http_server: braidify} = require('braid-http')

var port = process.env.PORT || 4000
var configs_file = 'configs.json'

// Load persisted configs or start fresh
var configs = {}
try { configs = JSON.parse(fs.readFileSync(configs_file, 'utf8')) } catch (e) {}

var subscribers = {}  // prefix -> [res, ...]
var versions = {}     // prefix -> number

function save_configs() {
    fs.writeFile(configs_file, JSON.stringify(configs, null, 2), () => {})
}

function get_config(prefix) {
    if (!configs[prefix])
        configs[prefix] = {delay_ms: 0}
    return configs[prefix]
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

// TCP delay: FIFO queue, each chunk stamped with a delivery time, drained in order.
// Simulates a pipeline — chunks are in flight concurrently but arrive in order.
function delay_stream(get_delay) {
    var queue = []
    var timer = null
    var flush_cb = null

    var t = new Transform({
        transform(chunk, enc, cb) {
            queue.push({chunk, deliver_at: Date.now() + get_delay()})
            if (!timer) schedule()
            cb()
        },
        flush(cb) {
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
        if (!hop_by_hop.has(key.toLowerCase()))
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
            label.innerHTML = key + ': <span class="val">' + Math.round(val) + '</span><br>'
            var input = document.createElement('input')
            input.type = 'range'
            input.min = 0
            input.max = key.match(/ms/) ? 5000 : 100
            input.step = 'any'
            input.value = val
            input.dataset.key = key
            input.oninput = function () {
                var v = Math.round(Number(this.value))
                config[this.dataset.key] = v
                this.parentNode.querySelector('.val').textContent = v
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
    var config = get_config(prefix)
    var get_delay = () => config.delay_ms || 0

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
        res.writeHead(upstream_res.statusCode, forward_headers(upstream_res.headers, {}))
        upstream_res
            .pipe(delay_stream(get_delay))
            .pipe(res)
    })

    // Pipe request body through delay to upstream
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
        upstream.end()
    } else {
        req .pipe(delay_stream(get_delay))
            .pipe(upstream)
    }
}

// WebSocket proxy with bidirectional delay
function proxy_ws(req, client_socket, head, prefix, target) {
    // Parse target — support ws:// and wss:// as well as http:// and https://
    var url = new URL(target)
    var is_secure = url.protocol === 'wss:' || url.protocol === 'https:'
    var config = get_config(prefix)
    var get_delay = () => config.delay_ms || 0

    var target_port = url.port || (is_secure ? 443 : 80)

    // Connect to upstream
    var upstream_socket
    var connect_event
    if (is_secure) {
        upstream_socket = tls.connect({host: url.hostname, port: target_port, servername: url.hostname})
        connect_event = 'secureConnect'
    } else {
        upstream_socket = net.connect({host: url.hostname, port: target_port})
        connect_event = 'connect'
    }

    upstream_socket.on('error', e => {
        console.log('ws upstream error:', e.code || e.message)
        client_socket.destroy()
    })
    client_socket.on('error', e => {
        console.log('ws client error:', e.code || e.message)
        upstream_socket.destroy()
    })

    // Build the upgrade request — forward original ws headers
    var path = (url.pathname || '/') + (url.search || '')
    var headers = forward_headers(req.headers, {host: url.host})
    // Restore hop-by-hop headers needed for ws upgrade
    headers.connection = 'Upgrade'
    headers.upgrade = 'websocket'

    var raw_request = 'GET ' + path + ' HTTP/1.1\r\n'
    for (var key in headers)
        raw_request += key + ': ' + headers[key] + '\r\n'
    raw_request += '\r\n'

    upstream_socket.on(connect_event, () => {
        upstream_socket.write(raw_request)
        if (head && head.length) upstream_socket.write(head)

        // Wait for the 101 response from upstream
        var response_buf = Buffer.alloc(0)
        var headers_done = false

        upstream_socket.on('data', function on_upgrade_data(chunk) {
            if (headers_done) return

            response_buf = Buffer.concat([response_buf, chunk])
            var header_end = response_buf.indexOf('\r\n\r\n')
            if (header_end === -1) return

            headers_done = true
            upstream_socket.removeListener('data', on_upgrade_data)

            // Forward the 101 response to client
            var header_part = response_buf.slice(0, header_end + 4)
            var remainder = response_buf.slice(header_end + 4)

            client_socket.write(header_part)

            // If there's data after the headers, push it through
            if (remainder.length)
                upstream_socket.unshift(remainder)

            // Pipe bidirectionally with delay
            client_socket
                .pipe(delay_stream(get_delay))
                .pipe(upstream_socket)
            upstream_socket
                .pipe(delay_stream(get_delay))
                .pipe(client_socket)
        })
    })
}

// Main server
var server = http.createServer(function (req, res) {
    var {prefix, target} = parse_path(req.url)

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
    if (!target) {
        socket.destroy()
        return
    }
    proxy_ws(req, socket, head, prefix, target)
})

server.listen(port, () => console.log('bad braid on port', port))
