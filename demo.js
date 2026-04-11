var http = require('http')
var {http_server: braidify} = require('braid-http')

var text = ''
var version = 0
var subs = []

var server = http.createServer(function (req, res) {
    braidify(req, res)
    if (req.is_multiplexer) return

    // Test script — loaded via root-relative URL to test referer-based proxying
    if (req.url === '/script.js') {
        res.writeHead(200, {'Content-Type': 'application/javascript'})
        res.end('document.getElementById("script-status").textContent = "loaded!"')
        return
    }

    // Braid-synced text at /
    if (req.method === 'PUT') {
        var put_ver = req.version ? Number(req.version[0]) : 0
        var body = ''
        req.on('data', chunk => body += chunk)
        req.on('end', () => {
            // Reject stale PUTs that arrived out of order
            if (put_ver <= version) {
                res.writeHead(432)
                res.end()
                return
            }
            text = body
            version = put_ver
            for (var sub of subs)
                sub.sendUpdate({version: ['' + version], body: text})
            res.writeHead(200)
            res.end()
        })
        return
    }

    // GET — serve HTML or braid-synced text
    if (!req.subscribe && !req.headers.accept?.includes('application/json')) {
        res.writeHead(200, {'Content-Type': 'text/html'})
        res.end(page_html)
        return
    }

    res.setHeader('Content-Type', 'application/json')
    if (req.subscribe) {
        res.startSubscription({
            onClose: () => { subs = subs.filter(s => s !== res) }
        })
        subs.push(res)
    }
    res.sendUpdate({version: ['' + version], body: text})
    if (!req.subscribe) res.end()
})

server.listen(3000, () => console.log('demo on http://localhost:3000'))

var page_html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Braid Text — Bad Braid Demo</title>
  <style>
    body {
      font-family: monospace;
      max-width: 700px; margin: 60px auto; padding: 0 20px;
      background: #1a1a2e; color: #ccc
    }
    h1 { font-weight: normal; color: #eee }
    h2 { font-weight: normal; color: #999; font-size: 14px; margin-top: 40px }
    textarea {
      width: 100%; height: 120px; font-family: monospace; font-size: 16px;
      background: #16213e; color: #eee; border: 2px solid #444; padding: 12px;
      border-radius: 4px; resize: vertical
    }
    textarea:focus { outline: none; border-color: #ffe066 }
    .server-view {
      background: #0f3460; border: 2px solid #444; padding: 12px;
      min-height: 120px; white-space: pre-wrap; font-size: 16px;
      border-radius: 4px; color: #8888ff; word-wrap: break-word
    }
    .status { font-size: 12px; color: #666; margin: 4px 0 }
    .info {
      margin-top: 40px; line-height: 1.8; color: #888;
      border-top: 1px solid #333; padding-top: 20px
    }
    a { color: #ffe066 }
    .lag-indicator {
      display: inline-block; width: 8px; height: 8px; border-radius: 50%;
      background: #333; margin-left: 8px; vertical-align: middle
    }
    .lag-indicator.sending { background: #ffe066 }
    .lag-indicator.synced { background: #66ff88 }
  </style>
</head>
<body>
  <h1>Braid Text</h1>
  <p>Type below. The server's view appears underneath — separated by the network.</p>

  <h2>You type here <span class="lag-indicator" id="send-lag"></span></h2>
  <textarea id="input" placeholder="start typing..."></textarea>
  <div class="status" id="send-status"></div>

  <h2>Server sees this <span class="lag-indicator" id="recv-lag"></span></h2>
  <div class="server-view" id="server-view"></div>
  <div class="status" id="recv-status"></div>

  <p>/script.js (root-relative): <span id="script-status" style="color:#ff6666">not loaded</span></p>
  <script src="/script.js"></script>

  <div class="info">
    <p>Access this page through Bad Braid to add latency:</p>
    <p><code style="background:#333;padding:4px 8px">http://localhost:4000/latency/http://localhost:3000/</code></p>
    <p>Then configure latency at <code style="background:#333;padding:4px 8px">http://localhost:4000/latency</code></p>
  </div>

  <script src="https://unpkg.com/braid-http/braid-http-client.js"></script>
  <script>
    var input = document.getElementById('input')
    var server_view = document.getElementById('server-view')
    var send_lag = document.getElementById('send-lag')
    var recv_lag = document.getElementById('recv-lag')
    var send_status = document.getElementById('send-status')
    var recv_status = document.getElementById('recv-status')

    var inflight = 0

    // Subscribe to server's view of the text
    async function subscribe() {
        var res = await braid_fetch(location.href, {
            subscribe: true,
            retry: true,
            headers: {Accept: 'application/json'}
        })
        res.subscribe(function (update) {
            server_view.textContent = update.body_text || ''
            recv_lag.className = 'lag-indicator synced'
            recv_status.textContent = 'updated at ' + new Date().toLocaleTimeString()
            setTimeout(() => recv_lag.className = 'lag-indicator', 300)
        })
    }

    // Send text on each keystroke — versioned so server ignores stale PUTs
    var put_version = 0
    var inflight = 0

    input.addEventListener('input', function () {
        send()
    })

    async function send() {
        inflight++
        put_version++
        send_lag.className = 'lag-indicator sending'
        var start = performance.now()

        var res = await braid_fetch(location.href, {
            method: 'PUT',
            version: ['' + put_version],
            headers: {'Content-Type': 'text/plain'},
            body: input.value
        })

        inflight--
        var rtt = Math.round(performance.now() - start)
        send_status.textContent = 'PUT round-trip: ' + rtt + ' ms'

        // Server rejected as stale — resend with fresh version and current value
        if (res.status === 432) return send()

        if (inflight === 0) {
            send_lag.className = 'lag-indicator synced'
            setTimeout(() => {
                if (inflight === 0) send_lag.className = 'lag-indicator'
            }, 300)
        }
    }

    subscribe()
  </script>
</body>
</html>`
