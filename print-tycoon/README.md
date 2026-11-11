# 3D Print Tycoon (Roblox)

A Roblox tycoon game about running a 3D printing farm. Every print is
**sliced into layers and built in front of you**: the print head glides back and
forth while strips of filament grow behind it, one layer at a time.

## How to play

1. You spawn on your own print farm with a free **Starter FDM** printer.
2. Walk up to a printer and press **E**. Pick a **blueprint** (what to print) and
   a **filament** (what it's made of), then hit **PRINT!**
3. Watch it print. When it's finished, press **E** again to sell it.
4. Spend your cash in the **Shop**:
   - **Printers**: finer resolution, faster layers, better quality, fewer failed prints
   - **Blueprints**: Cube → Pyramid → Sphere → Spiral Vase → Donut → Castle Rook → Rocket → Heart → Twisted Tower
   - **Filaments**: PLA, PETG, Silk Copper, Glow-in-the-Dark (neon), Carbon Fiber, Gold
   - **Upgrades**: Conveyor Collector (auto-sell), Print Queue (auto-reprint), Spaghetti Detector
5. Cheap printers sometimes fail and turn your print into a pile of **spaghetti** 🍝,
   which only sells for scrap.

Your farm holds 6 printers. When it's full, buying a better printer swaps out
your weakest idle one and gives back 50% of what it cost.

Progress saves automatically (DataStores).

## Option A: open the ready-made place file (easiest)

1. Open **`PrintTycoon.rbxlx`** in Roblox Studio (File → Open from File).
2. Press **Play**.
3. To keep progress between play sessions in Studio, enable
   *Game Settings → Security → Enable Studio Access to API Services*
   (the game must be published first). Without it, the game still works but
   doesn't save.

## Option B: develop with Rojo (recommended for editing code)

This project uses [Rojo](https://rojo.space) so the code lives in normal text files.

```bash
rojo serve
```

Then in Studio, install the Rojo plugin, click **Connect**, and edits in `src/`
sync live into Studio. To rebuild the place file:

```bash
rojo build -o PrintTycoon.rbxlx
```

## Option C: copy the scripts by hand

If you'd rather not use Rojo, create these in Studio and paste in the matching file:

| Studio location | Type | File |
| --- | --- | --- |
| ReplicatedStorage → Folder `Shared` | ModuleScript `Config` | `src/shared/Config.luau` |
| ReplicatedStorage → Folder `Shared` | ModuleScript `Shapes` | `src/shared/Shapes.luau` |
| ReplicatedStorage → Folder `Shared` | ModuleScript `Util` | `src/shared/Util.luau` |
| ServerScriptService → Folder `Server` | Script `Main` | `src/server/Main.server.luau` |
| ServerScriptService → Folder `Server` | ModuleScript `DataService` | `src/server/DataService.luau` |
| ServerScriptService → Folder `Server` | ModuleScript `PlotService` | `src/server/PlotService.luau` |
| ServerScriptService → Folder `Server` | ModuleScript `PrinterService` | `src/server/PrinterService.luau` |
| StarterPlayer → StarterPlayerScripts | LocalScript `UI` | `src/client/UI.client.luau` |

## Code tour

| File | What it does |
| --- | --- |
| `src/shared/Config.luau` | **All game balance**: printers, blueprints, filaments, upgrades, prices. Start here to tweak. |
| `src/shared/Shapes.luau` | Each blueprint is a math function `inside(u, v, h)`. `Shapes.slice()` turns it into layers of nozzle "runs", like a real slicer. |
| `src/server/PrinterService.luau` | Builds printer models (frame, gantry, nozzle, spool, status sign) and runs the layer-by-layer print animation, failures, and selling. |
| `src/server/PlotService.luau` | Builds the 6 plots and the spawn, assigns a plot to each player. |
| `src/server/DataService.luau` | Saving/loading, cash, and leaderstats. |
| `src/server/Main.server.luau` | Entry point, remotes, shop purchases (all validated on the server). |
| `src/client/UI.client.luau` | HUD, shop, print menu, and notifications, all built in code. |

### Adding a new blueprint

1. Add a shape to `Shapes.luau`:
   ```lua
   defs.Mushroom = function(u, v, h)
       local d = math.sqrt(u * u + v * v)
       if h < 0.5 then return d <= 0.3 end            -- stem
       return d * d + ((h - 0.5) * 2) ^ 2 <= 0.9      -- cap
   end
   ```
2. Add it to `Config.Blueprints`:
   ```lua
   { id = "Mushroom", name = "Mushroom", price = 1000, value = 45, complexity = 1.3 },
   ```

That's it. The shop, print menu, and slicer pick it up automatically.

## Ideas for what to add next

- Sounds (printer hum, cash register on sale)
- A display shelf to show off your best prints
- Rebirths (reset for a permanent value multiplier)
- Game passes (e.g. 2x cash) using `MarketplaceService`
- Customer orders that ask for a specific blueprint and filament for a bonus
