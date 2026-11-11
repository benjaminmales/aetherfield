# Aetherfield Demo Server

Runs your Aetherfield demo kit from your own computer: a console in your
browser, plus a REST API and live feed for your own software. Works without
an internet connection.

## You need

- **Node.js 20 or later**: https://nodejs.org (the "LTS" installer)
- macOS, Windows or Linux

Everything else is included. Nothing to install or download.

## Start it

**macOS:** double-click `Start Demo Server.command`
(first time: right-click it → Open → Open, because it came from a download)

**Windows:** double-click `Start Demo Server.bat`

**Or from a terminal, on any system,** in this folder:

    npm start

Then open **http://localhost:3000**. The first time, your computer may ask
whether `node` can accept incoming connections. Say yes, or the Aura Links
can't connect.

## Try it without hardware

With the server running, in a second terminal in this folder:

    npm run simulate

Eight simulated Aura Tags appear in the console, moving and reporting
battery, so you can try the controls, behaviours and API straight away.
Stop it with Ctrl+C and they go quiet.

## Keep it running

    npm run service:install

Run once. The server then starts whenever you log in and restarts if it
stops. `npm run service:status` checks it; `npm run service:uninstall`
removes it.

## Connect your Aura Links and your software

Full guide, network setup and API reference: **https://aetherfield.ai/wiki**

| | |
|---|---|
| Console | http://localhost:3000 |
| REST API | http://localhost:3000/api/v1 |
| Live feed | ws://localhost:3000/ws |
| Aura Links connect on | port 9000 |

From another computer on the same network, replace `localhost` with this
computer's IP address.

## Your data

Names, behaviours and settings are saved in the `data` folder. To move to a
newer version of the Demo Server, copy `data` into the new folder.

Optional settings (ports, an API key) go in a file called `.env`; see
`.env.example`.
