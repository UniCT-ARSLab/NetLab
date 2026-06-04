# NetLab

Applicazione desktop per la creazione e gestione di laboratori di rete virtuali, pensata per studenti. Basata su Electron + Angular, usa Docker come backend per eseguire i nodi di rete.

---

## Architettura

```
netapp/
├── electron/          # Main process Electron (entry point, IPC handlers, logger, preload)
├── backend/
│   ├── models/        # Modelli dati condivisi (LabNode, LabLink, IPC channels)
│   └── services/      # Logica di business (Node, Network, DB, Terminal, Docker client)
├── frontend/          # Applicazione Angular (renderer process)
│   └── src/app/
│       ├── components/
│       └── services/
└── scripts/           # Script di build e post-install
```

Il processo **main** (Electron) gestisce Docker, il filesystem e i terminali PTY. Il **renderer** (Angular) comunica con il main esclusivamente tramite IPC via `window.electronAPI` esposto dal preload con `contextBridge`.

---

## Concetti chiave

### Nodi
Un nodo è un container Docker che rappresenta un dispositivo di rete (router, host, firewall…). Ogni nodo ha:
- un'immagine Docker (es. `kathara/base`)
- zero o più interfacce, ciascuna opzionalmente collegata a un link
- un flag `internetFacing` per abilitare accesso a internet tramite NAT

### Link
Un link è una rete Docker di tipo bridge con prefisso `netlab_`. Connette al massimo 2 nodi. Le reti WAN (prefisso `netlab_wan_<nodeId>`) sono riservate ai nodi internet-facing e non appaiono nella lista link.

### Persistenza
Lo stato (nodi e link) viene salvato in `netlab-data.json` nella directory `userData` di Electron. Al riavvio dell'app, `NodeService` e `NetworkService` riconciliano lo stato salvato con i container/reti Docker effettivamente presenti.

---

## Flusso di avvio di un nodo

1. `NodeService.start()` avvia il container Docker
2. `NetworkService.cleanOrphanedInterfaces()` rimuove eventuali interfacce veth orfane rimaste dal run precedente (carrier=0)
3. Per ogni interfaccia del nodo collegata a un link: `NetworkService.attachInterface()` connette il container alla rete Docker e rinomina l'interfaccia nel namespace del container tramite `docker exec`
4. Se il nodo è `internetFacing`: `NetworkService.createWanBridge()` crea o riutilizza la rete WAN e la collega al container

La configurazione di rete (indirizzi IP, rotte, iptables) è completamente delegata al sistema operativo del container. L'utente può usare `/etc/network/interfaces` e configurare regole iptables manualmente dal terminale del nodo.

---

## Rinomina interfacce

Docker connette le reti a un container assegnando interfacce con nomi arbitrari (`eth0`, `eth1`, …) in ordine non deterministico. Per garantire che `eth0` corrisponda sempre al primo link configurato, l'app usa un approccio **MAC-based**:

1. Dopo la connessione alla rete Docker, viene letto il MAC dell'endpoint da `network.inspect()`
2. Un `docker exec` dentro il container cerca l'interfaccia con quel MAC in `/sys/class/net/eth[0-9]*` e la rinomina al nome atteso (es. `eth0`)
3. Se il nome target è già occupato da un'altra interfaccia, questa viene temporaneamente rinominata `eth_tmp` (che continua a matchare il glob `eth*` per eventuali operazioni successive)

---

## Reti WAN

Le reti WAN (`netlab_wan_<nodeId>`) hanno `ip_masquerade=true` per abilitare il NAT verso internet.

- La rete viene **creata una sola volta** e riutilizzata tra stop/start successivi del nodo: in questo modo Docker IPAM mantiene lo stesso indirizzo IP assegnato al container senza incrementarlo ad ogni restart.
- Il MAC dell'interfaccia WAN viene letto da `container.inspect().NetworkSettings.Networks[networkName].MacAddress` (visibile anche con container stoppato) per evitare l'errore "endpoint already exists" che si verifica su alcune piattaforme quando si tenta di riconnettere un endpoint già esistente.
- La rete WAN viene eliminata solo alla cancellazione del nodo (`deleteWanBridge` chiamata da `NODE_DELETE`).

Il NAT è gestito da Docker. L'utente deve configurare manualmente `ip_forward` e le regole `iptables MASQUERADE` all'interno del container router per far funzionare il forwarding tra le reti interne e la WAN.

---

## IPC Channels

Tutta la comunicazione renderer → main avviene tramite `ipcMain.handle` / `ipcRenderer.invoke`.

| Canale | Scopo |
|--------|-------|
| `node:list` | Lista nodi |
| `node:create` | Crea nodo |
| `node:update` | Modifica nodo (solo offline) |
| `node:start` | Avvia container + attach interfacce + WAN |
| `node:stop` | Ferma container |
| `node:delete` | Elimina nodo e container |
| `node:network-info` | `ip addr` + `ip route` dal container in esecuzione |
| `link:list` | Lista link con nodi connessi |
| `link:create` | Crea rete Docker bridge |
| `link:delete` | Rimuove rete Docker |
| `terminal:open` | Apre PTY nel container |
| `terminal:open-window` | Apre finestra terminale separata |
| `terminal:input` / `terminal:resize` / `terminal:close` | Gestione PTY |
| `docker:check` | Verifica disponibilità Docker daemon |

---

## Sviluppo

### Prerequisiti
- Node.js ≥ 18
- Docker in esecuzione
- Angular CLI (`npm install -g @angular/cli`)

### Avvio in modalità sviluppo

```bash
# Installa dipendenze root
npm install

# Installa dipendenze frontend
cd frontend && npm install && cd ..

# Avvia tutto (frontend dev server + compilazione backend + Electron)
npm run dev
```

### Build per distribuzione

```bash
npm run package        # build per la piattaforma corrente
npm run package:win    # Windows (NSIS installer)
npm run package:mac    # macOS (DMG, x64 + arm64)
npm run package:linux  # Linux (AppImage)
```

Gli artefatti finali vengono emessi nella directory `release/`.

---

## Configurazione di rete all'interno di un nodo

Poiché openrc/init non è PID 1 nei container Docker, i servizi di rete non si avviano automaticamente al boot del container. La configurazione va applicata manualmente o tramite file standard:

- **`/etc/network/interfaces`**: configurazione interfacce (Alpine/Kathara). Dopo aver modificato il file, applicare con `ifup <iface>` o `ifup -a` dal terminale del nodo.
- **Rotte**: `ip route add <dest> via <gw>`
- **iptables**: le regole iptables si resettano ad ogni restart del container. Per ripristinarle: `iptables-restore < /root/iptables.bak` (dopo averle salvate con `iptables-save > /root/iptables.bak`).

Gli indirizzi IP Docker (interfaccia WAN) rimangono stabili tra stop/start finché il nodo non viene eliminato, grazie al riutilizzo dell'endpoint IPAM.
