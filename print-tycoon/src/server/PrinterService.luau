--[[
	PrinterService: builds printer models and runs prints.

	A print is sliced into layers (see Shapes.luau). For every run in a layer
	the print head glides to the end of the run while a strip of filament grows
	behind it, so players watch their object being built up layer by layer.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService = game:GetService("TweenService")

local Config = require(ReplicatedStorage.Shared.Config)
local Shapes = require(ReplicatedStorage.Shared.Shapes)
local Util = require(ReplicatedStorage.Shared.Util)
local DataService = require(script.Parent.DataService)

local PrinterService = {}

local remotes = nil
local states: { [Player]: { [number]: any } } = {}
local rng = Random.new()

local DARK = Color3.fromRGB(35, 37, 44)
local METAL = Color3.fromRGB(150, 155, 165)

local function notify(player: Player, text: string, kind: string?)
	if remotes then
		remotes.Notify:FireClient(player, text, kind or "info")
	end
end

local function part(props)
	local p = Instance.new("Part")
	p.Anchored = true
	p.TopSurface = Enum.SurfaceType.Smooth
	p.BottomSurface = Enum.SurfaceType.Smooth
	p.CastShadow = false
	for k, v in props do
		if k ~= "Parent" then
			(p :: any)[k] = v
		end
	end
	p.Parent = props.Parent
	return p
end

--------------------------------------------------------------------------------
-- Model building
--------------------------------------------------------------------------------

local function buildModel(def, slotCF: CFrame, parent: Instance)
	local B = def.buildSize
	local frameW = B + 3
	local H = B + 3.2
	local half = frameW / 2 - 0.3

	local model = Instance.new("Model")
	model.Name = def.name

	local base = part({
		Name = "Base",
		Size = Vector3.new(frameW, 0.8, frameW),
		CFrame = slotCF * CFrame.new(0, 0.4, 0),
		Color = DARK,
		Parent = model,
	})
	model.PrimaryPart = base

	part({
		Name = "Bed",
		Size = Vector3.new(B + 0.6, 0.2, B + 0.6),
		CFrame = slotCF * CFrame.new(0, 0.9, 0),
		Color = Color3.fromRGB(20, 20, 24),
		Material = Enum.Material.Glass,
		Parent = model,
	})

	-- Frame: 4 posts + 4 top rails.
	for _, sx in { -1, 1 } do
		for _, sz in { -1, 1 } do
			part({
				Name = "Post",
				Size = Vector3.new(0.5, H, 0.5),
				CFrame = slotCF * CFrame.new(sx * half, 0.8 + H / 2, sz * half),
				Color = def.color,
				Material = Enum.Material.Metal,
				Parent = model,
			})
		end
	end
	for _, sz in { -1, 1 } do
		part({
			Name = "Rail",
			Size = Vector3.new(frameW - 0.1, 0.4, 0.4),
			CFrame = slotCF * CFrame.new(0, 0.8 + H, sz * half),
			Color = def.color,
			Material = Enum.Material.Metal,
			Parent = model,
		})
		part({
			Name = "Rail",
			Size = Vector3.new(0.4, 0.4, frameW - 0.1),
			CFrame = slotCF * CFrame.new(sz * half, 0.8 + H, 0),
			Color = def.color,
			Material = Enum.Material.Metal,
			Parent = model,
		})
	end

	-- Moving parts.
	local gantry = part({
		Name = "Gantry",
		Size = Vector3.new(frameW - 0.6, 0.35, 0.35),
		Color = METAL,
		Material = Enum.Material.Metal,
		CanCollide = false,
		Parent = model,
	})
	local carriage = part({
		Name = "Carriage",
		Size = Vector3.new(0.8, 0.8, 0.8),
		Color = def.color,
		CanCollide = false,
		Parent = model,
	})
	local nozzle = part({
		Name = "Nozzle",
		Size = Vector3.new(0.25, 0.5, 0.25),
		Color = Color3.fromRGB(255, 170, 60),
		Material = Enum.Material.Metal,
		CanCollide = false,
		Parent = model,
	})
	local light = Instance.new("PointLight")
	light.Color = Color3.fromRGB(255, 170, 80)
	light.Range = 6
	light.Brightness = 2
	light.Enabled = false
	light.Parent = nozzle

	-- Filament spool on the side (recoloured to match each print).
	local spool = part({
		Name = "Spool",
		Shape = Enum.PartType.Cylinder,
		Size = Vector3.new(1, 2.6, 2.6),
		CFrame = slotCF * CFrame.new(frameW / 2 + 0.6, 0.8 + H * 0.55, 0),
		Color = Color3.fromRGB(235, 235, 235),
		Parent = model,
	})
	part({
		Name = "SpoolHub",
		Shape = Enum.PartType.Cylinder,
		Size = Vector3.new(1.1, 1, 1),
		CFrame = spool.CFrame,
		Color = DARK,
		Parent = model,
	})

	if def.enclosure then
		part({
			Name = "Enclosure",
			Size = Vector3.new(frameW - 0.2, H, frameW - 0.2),
			CFrame = slotCF * CFrame.new(0, 0.8 + H / 2, 0),
			Color = def.enclosure,
			Material = Enum.Material.Glass,
			Transparency = 0.8,
			CanCollide = false,
			CanQuery = false,
			Parent = model,
		})
	end

	-- Status sign floating above the printer.
	local billboard = Instance.new("BillboardGui")
	billboard.Size = UDim2.fromScale(7, 2)
	billboard.StudsOffset = Vector3.new(0, H + 2.5, 0)
	billboard.MaxDistance = 90
	billboard.AlwaysOnTop = false
	billboard.Adornee = base
	billboard.Parent = base

	local title = Instance.new("TextLabel")
	title.Name = "Title"
	title.Size = UDim2.fromScale(1, 0.4)
	title.BackgroundTransparency = 1
	title.Font = Enum.Font.GothamBlack
	title.TextScaled = true
	title.TextColor3 = Color3.new(1, 1, 1)
	title.TextStrokeTransparency = 0.4
	title.Text = def.name
	title.Parent = billboard

	local status = title:Clone()
	status.Name = "Status"
	status.Position = UDim2.fromScale(0, 0.4)
	status.Size = UDim2.fromScale(1, 0.32)
	status.Font = Enum.Font.GothamBold
	status.TextColor3 = Color3.fromRGB(200, 205, 215)
	status.Text = "Idle"
	status.Parent = billboard

	local barBack = Instance.new("Frame")
	barBack.Position = UDim2.fromScale(0.1, 0.8)
	barBack.Size = UDim2.fromScale(0.8, 0.14)
	barBack.BackgroundColor3 = Color3.fromRGB(20, 20, 25)
	barBack.BorderSizePixel = 0
	barBack.Visible = false
	barBack.Parent = billboard
	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(1, 0)
	corner.Parent = barBack
	local bar = Instance.new("Frame")
	bar.Size = UDim2.fromScale(0, 1)
	bar.BackgroundColor3 = Color3.fromRGB(255, 150, 40)
	bar.BorderSizePixel = 0
	bar.Parent = barBack
	corner:Clone().Parent = bar

	-- Interaction prompt at the front of the printer.
	local attachment = Instance.new("Attachment")
	attachment.Position = Vector3.new(0, 2, -frameW / 2)
	attachment.Parent = base
	local prompt = Instance.new("ProximityPrompt")
	prompt.ObjectText = def.name
	prompt.ActionText = "Start Print"
	prompt.KeyboardKeyCode = Enum.KeyCode.E
	prompt.HoldDuration = 0
	prompt.MaxActivationDistance = 12
	prompt.RequiresLineOfSight = false
	prompt.Parent = attachment

	local printFolder = Instance.new("Folder")
	printFolder.Name = "Print"
	printFolder.Parent = model

	model.Parent = parent

	return {
		model = model,
		base = base,
		gantry = gantry,
		carriage = carriage,
		nozzle = nozzle,
		light = light,
		spool = spool,
		statusLabel = status,
		bar = bar,
		barBack = barBack,
		prompt = prompt,
		printFolder = printFolder,
	}
end

--------------------------------------------------------------------------------
-- Head movement helpers (all positions are in the printer's local space)
--------------------------------------------------------------------------------

local function headCFrames(state, x: number, y: number, z: number)
	local cf = state.slotCF
	return {
		nozzle = cf * CFrame.new(x, y + 0.25, z),
		carriage = cf * CFrame.new(x, y + 0.9, z),
		gantry = cf * CFrame.new(0, y + 0.9, z),
	}
end

local function moveHead(state, x: number, y: number, z: number, duration: number)
	local targets = headCFrames(state, x, y, z)
	for name, target in targets do
		local p = state.parts[name]
		if duration <= 0.02 then
			p.CFrame = target
		else
			local info = TweenInfo.new(duration, Enum.EasingStyle.Linear)
			TweenService:Create(p, info, { CFrame = target }):Play()
		end
	end
end

local function parkHead(state, duration: number)
	local B = state.def.buildSize
	moveHead(state, 0, 1 + B + 0.6, -B / 2, duration)
end

--------------------------------------------------------------------------------
-- Status display
--------------------------------------------------------------------------------

local function setStatus(state, status: string, text: string?)
	state.status = status
	local prompt = state.parts.prompt
	if status == "Idle" then
		prompt.Enabled = true
		prompt.ActionText = "Start Print"
		state.parts.statusLabel.Text = "Idle - press E"
		state.parts.barBack.Visible = false
	elseif status == "Printing" then
		prompt.Enabled = false
		state.parts.barBack.Visible = true
	elseif status == "Done" or status == "Failed" then
		prompt.Enabled = true
		prompt.ActionText = "Collect " .. Util.formatCash(state.job.payout)
		state.parts.barBack.Visible = false
	end
	if text then
		state.parts.statusLabel.Text = text
	end
end

local function setProgress(state, alpha: number)
	state.parts.bar.Size = UDim2.fromScale(math.clamp(alpha, 0, 1), 1)
end

--------------------------------------------------------------------------------
-- Printing
--------------------------------------------------------------------------------

local function styleFilament(p: BasePart, filament)
	p.Color = filament.color
	p.Material = filament.material
	p.Transparency = filament.transparency or 0
end

local function makeSpaghetti(state, filament, fromY: number)
	local B = state.def.buildSize
	local s = B / state.def.resolution
	local count = 28
	for i = 1, count do
		if state.destroyed then
			return
		end
		local x = rng:NextNumber(-B / 2, B / 2)
		local z = rng:NextNumber(-B / 2, B / 2)
		local y = fromY + rng:NextNumber(0, B * 0.25)
		local strand = part({
			Name = "Spaghetti",
			Size = Vector3.new(s * 0.3, s * 0.3, rng:NextNumber(0.6, 2)),
			CFrame = state.slotCF
				* CFrame.new(x, y, z)
				* CFrame.Angles(rng:NextNumber(0, math.pi), rng:NextNumber(0, math.pi), rng:NextNumber(0, math.pi)),
			CanCollide = false,
			Parent = state.parts.printFolder,
		})
		styleFilament(strand, filament)
		-- The head flails around while it extrudes into thin air.
		moveHead(state, x, y, z, 0.08)
		setProgress(state, 1 - i / count)
		task.wait(0.08)
	end
end

local function runPrint(state)
	local job = state.job
	local def = state.def
	local bp, filament = job.blueprint, job.filament
	local B = def.buildSize
	local layers = Shapes.slice(bp.id, def.resolution)
	local s = B / def.resolution
	local bedTop = 1.0
	local layerDuration = def.layerTime * bp.complexity

	state.parts.spool.Color = filament.color
	state.parts.light.Enabled = true

	local failLayer = math.huge
	if job.failed then
		failLayer = math.max(2, math.floor(#layers * rng:NextNumber(0.3, 0.7)))
	end

	for li, layer in layers do
		if state.destroyed then
			return
		end
		if li >= failLayer then
			setStatus(state, "Printing", "Uh oh... spaghetti!")
			makeSpaghetti(state, filament, bedTop + (li - 1) * s)
			break
		end

		local y = bedTop + (li - 0.5) * s
		local headY = bedTop + li * s
		local runDuration = layerDuration / math.max(#layer, 1)
		local layerStart = os.clock()

		for ri, run in layer do
			if state.destroyed then
				return
			end
			local xa, xb = math.min(run.x0, run.x1), math.max(run.x0, run.x1)
			local width = (xb - xa + 1) * s
			local centerX = -B / 2 + ((xa - 1) + xb) / 2 * s
			local z = -B / 2 + (run.z - 0.5) * s
			-- Edge of the run the nozzle starts from (runs alternate direction).
			local startX = if run.x0 <= run.x1 then -B / 2 + (xa - 1) * s else -B / 2 + xb * s
			local endX = if run.x0 <= run.x1 then -B / 2 + xb * s else -B / 2 + (xa - 1) * s

			local startWidth = math.min(s, width)
			local direction = if endX >= startX then 1 else -1
			local strip = part({
				Name = "Layer" .. li,
				Size = Vector3.new(startWidth, s, s),
				CFrame = state.slotCF * CFrame.new(startX + direction * startWidth / 2, y, z),
				Parent = state.parts.printFolder,
			})
			styleFilament(strip, filament)

			moveHead(state, endX, headY, z, runDuration)
			if runDuration > 0.03 then
				TweenService:Create(
					strip,
					TweenInfo.new(runDuration, Enum.EasingStyle.Linear),
					{ Size = Vector3.new(width, s, s), CFrame = state.slotCF * CFrame.new(centerX, y, z) }
				):Play()
			else
				strip.Size = Vector3.new(width, s, s)
				strip.CFrame = state.slotCF * CFrame.new(centerX, y, z)
			end

			-- Keep total time accurate even when runs are shorter than a frame.
			local target = layerStart + ri * runDuration
			local remaining = target - os.clock()
			if remaining > 0 then
				task.wait(remaining)
			end
		end

		setProgress(state, li / #layers)
		state.parts.statusLabel.Text = string.format("Printing %s  %d%%", bp.name, math.floor(li / #layers * 100))
	end

	if state.destroyed then
		return
	end

	state.parts.light.Enabled = false
	parkHead(state, 0.6)

	local profile = DataService.get(state.owner)
	if job.failed then
		job.payout = math.floor(job.value * Config.FailedPrintPayout)
		setStatus(state, "Failed", "Spaghetti! Sell for scrap")
		notify(state.owner, `{def.name}: print failed! Sell the spaghetti for scrap.`, "bad")
	else
		job.payout = job.value
		setStatus(state, "Done", `{bp.name} done!`)
	end

	if profile and profile.upgrades.AutoSell then
		task.delay(1.2, function()
			if not state.destroyed and (state.status == "Done" or state.status == "Failed") then
				PrinterService.collect(state.owner, state.slot)
			end
		end)
	end
end

local function floatText(state, text: string, color: Color3)
	local bb = Instance.new("BillboardGui")
	bb.Size = UDim2.fromScale(5, 1.5)
	bb.StudsOffset = Vector3.new(0, 3, 0)
	bb.Adornee = state.parts.base
	local label = Instance.new("TextLabel")
	label.Size = UDim2.fromScale(1, 1)
	label.BackgroundTransparency = 1
	label.Font = Enum.Font.GothamBlack
	label.TextScaled = true
	label.TextColor3 = color
	label.TextStrokeTransparency = 0.3
	label.Text = text
	label.Parent = bb
	bb.Parent = state.parts.base
	TweenService:Create(bb, TweenInfo.new(1.4), { StudsOffset = Vector3.new(0, 9, 0) }):Play()
	TweenService:Create(label, TweenInfo.new(1.4), { TextTransparency = 1, TextStrokeTransparency = 1 }):Play()
	task.delay(1.5, function()
		bb:Destroy()
	end)
end

--------------------------------------------------------------------------------
-- Public API
--------------------------------------------------------------------------------

function PrinterService.init(r)
	remotes = r
end

function PrinterService.spawn(player: Player, plot, slot: number, printerId: string)
	local def = Config.PrinterById[printerId]
	if not def or not plot.slots[slot] then
		return nil
	end
	states[player] = states[player] or {}
	PrinterService.remove(player, slot)

	local slotCF = plot.slots[slot]
	local parts = buildModel(def, slotCF, plot.printersFolder)
	local state = {
		owner = player,
		slot = slot,
		def = def,
		slotCF = slotCF,
		parts = parts,
		status = "Idle",
		job = nil,
		lastJob = nil,
		destroyed = false,
	}
	states[player][slot] = state
	parkHead(state, 0)
	setStatus(state, "Idle")

	parts.prompt.Triggered:Connect(function(who: Player)
		if who ~= state.owner then
			notify(who, `This printer belongs to {state.owner.DisplayName}.`, "bad")
			return
		end
		if state.status == "Idle" then
			remotes.OpenPrintMenu:FireClient(who, slot, def.id)
		elseif state.status == "Done" or state.status == "Failed" then
			PrinterService.collect(who, slot)
		end
	end)

	return state
end

function PrinterService.remove(player: Player, slot: number)
	local list = states[player]
	local state = list and list[slot]
	if state then
		state.destroyed = true
		state.parts.model:Destroy()
		list[slot] = nil
	end
end

function PrinterService.clearPlayer(player: Player)
	local list = states[player]
	if list then
		for slot in list do
			PrinterService.remove(player, slot)
		end
	end
	states[player] = nil
end

function PrinterService.getState(player: Player, slot: number)
	return states[player] and states[player][slot]
end

function PrinterService.startPrint(player: Player, slot: number, blueprintId: string, filamentId: string)
	local profile = DataService.get(player)
	local state = PrinterService.getState(player, slot)
	local bp = Config.BlueprintById[blueprintId]
	local filament = Config.FilamentById[filamentId]

	if not profile or not state then
		return false, "That printer doesn't exist."
	end
	if state.status ~= "Idle" then
		return false, "That printer is busy."
	end
	if not bp or not profile.blueprints[blueprintId] then
		return false, "You haven't unlocked that blueprint."
	end
	if not filament or not profile.filaments[filamentId] then
		return false, "You haven't unlocked that filament."
	end

	local value, cost, _, failChance = Config.estimate(state.def, bp, filament, profile.upgrades.Spaghetti)
	if not DataService.spend(player, cost) then
		return false, `You need {Util.formatCash(cost)} for the filament.`
	end

	state.job = {
		blueprint = bp,
		filament = filament,
		value = value,
		payout = 0,
		failed = rng:NextNumber() < failChance,
	}
	state.lastJob = { blueprintId = blueprintId, filamentId = filamentId }
	setStatus(state, "Printing", `Printing {bp.name}  0%`)
	setProgress(state, 0)
	task.spawn(runPrint, state)
	return true, `Printing {bp.name} in {filament.name}!`
end

function PrinterService.collect(player: Player, slot: number)
	local state = PrinterService.getState(player, slot)
	local profile = DataService.get(player)
	if not state or not profile or (state.status ~= "Done" and state.status ~= "Failed") then
		return
	end

	local success = state.status == "Done"
	local payout = state.job.payout
	-- Mark idle before awarding so a double-trigger can't pay twice.
	state.job = nil
	setStatus(state, "Idle")

	if success then
		profile.totalPrints += 1
	end
	DataService.addCash(player, payout)
	floatText(
		state,
		"+" .. Util.formatCash(payout),
		if success then Color3.fromRGB(90, 255, 120) else Color3.fromRGB(255, 120, 90)
	)

	-- Old print floats up and fades away (it's been "shipped").
	local old = state.parts.printFolder
	local fresh = Instance.new("Folder")
	fresh.Name = "Print"
	fresh.Parent = state.parts.model
	state.parts.printFolder = fresh
	local info = TweenInfo.new(0.7, Enum.EasingStyle.Quad, Enum.EasingDirection.In)
	for _, p in old:GetChildren() do
		if p:IsA("BasePart") then
			TweenService:Create(p, info, { CFrame = p.CFrame + Vector3.new(0, 4, 0), Transparency = 1 }):Play()
		end
	end
	task.delay(0.75, function()
		old:Destroy()
	end)

	-- Print Queue upgrade: start the same job again.
	if profile.upgrades.AutoRepeat and state.lastJob then
		local last = state.lastJob
		task.delay(0.8, function()
			if state.destroyed or state.status ~= "Idle" then
				return
			end
			local ok, message = PrinterService.startPrint(player, slot, last.blueprintId, last.filamentId)
			if not ok then
				notify(player, `{state.def.name} queue paused: {message}`, "bad")
			end
		end)
	end
end

function PrinterService.isIdle(player: Player, slot: number): boolean
	local state = PrinterService.getState(player, slot)
	return state ~= nil and state.status == "Idle"
end

return PrinterService
