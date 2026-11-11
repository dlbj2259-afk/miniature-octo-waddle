--[[
	Main: game entry point. Creates remotes, builds the world, and handles
	players joining/leaving and shop purchases.
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Config = require(ReplicatedStorage.Shared.Config)
local Util = require(ReplicatedStorage.Shared.Util)
local DataService = require(script.Parent.DataService)
local PlotService = require(script.Parent.PlotService)
local PrinterService = require(script.Parent.PrinterService)

-- Remotes ---------------------------------------------------------------------
local remoteFolder = Instance.new("Folder")
remoteFolder.Name = "Remotes"
local function remote(className: string, name: string)
	local r = Instance.new(className)
	r.Name = name
	r.Parent = remoteFolder
	return r
end
local remotes = {
	GetProfile = remote("RemoteFunction", "GetProfile"),
	Purchase = remote("RemoteFunction", "Purchase"),
	StartPrint = remote("RemoteFunction", "StartPrint"),
	GoHome = remote("RemoteEvent", "GoHome"),
	Profile = remote("RemoteEvent", "Profile"),
	OpenPrintMenu = remote("RemoteEvent", "OpenPrintMenu"),
	Notify = remote("RemoteEvent", "Notify"),
}
remoteFolder.Parent = ReplicatedStorage

DataService.setRemotes(remotes)
PrinterService.init(remotes)
PlotService.build()
DataService.start()

-- Players ---------------------------------------------------------------------
local function onPlayerAdded(player: Player)
	local profile = DataService.load(player)
	if not player.Parent then
		DataService.release(player)
		return
	end

	local plot = PlotService.claim(player)
	if not plot then
		player:Kick("The server is full of print farms! Please join another server.")
		return
	end

	-- Make sure there is always at least one printer.
	if #profile.printers == 0 then
		profile.printers = { "Starter" }
	end
	for slot, printerId in profile.printers do
		if slot <= Config.SlotsPerPlot then
			PrinterService.spawn(player, plot, slot, printerId)
		end
	end

	player.CharacterAdded:Connect(function(character)
		character:WaitForChild("HumanoidRootPart")
		task.wait()
		PlotService.teleportHome(player)
	end)
	if player.Character then
		PlotService.teleportHome(player)
	end

	DataService.sync(player)
end

Players.PlayerAdded:Connect(onPlayerAdded)
for _, player in Players:GetPlayers() do
	task.spawn(onPlayerAdded, player)
end

Players.PlayerRemoving:Connect(function(player)
	PrinterService.clearPlayer(player)
	PlotService.release(player)
	DataService.release(player)
end)

-- Remote handlers -------------------------------------------------------------
remotes.GetProfile.OnServerInvoke = function(player)
	return DataService.waitFor(player)
end

remotes.GoHome.OnServerEvent:Connect(function(player)
	PlotService.teleportHome(player)
end)

remotes.StartPrint.OnServerInvoke = function(player, slot, blueprintId, filamentId)
	if type(slot) ~= "number" or type(blueprintId) ~= "string" or type(filamentId) ~= "string" then
		return false, "Bad request."
	end
	return PrinterService.startPrint(player, slot, blueprintId, filamentId)
end

local function buyPrinter(player: Player, profile, def)
	local plot = PlotService.get(player)
	if not plot then
		return false, "You don't have a plot."
	end

	local slot = #profile.printers + 1
	local refund = 0
	if slot > Config.SlotsPerPlot then
		-- Farm is full: swap out the weakest idle printer (if it's worse).
		local worstSlot, worstOrder = nil, math.huge
		for i, id in profile.printers do
			local existing = Config.PrinterById[id]
			local order = if existing then existing.order else 0
			if order < worstOrder and PrinterService.isIdle(player, i) then
				worstSlot, worstOrder = i, order
			end
		end
		if not worstSlot or worstOrder >= def.order then
			return false, "Your farm is full! Upgrades replace your weakest idle printer."
		end
		slot = worstSlot
		local old = Config.PrinterById[profile.printers[slot]]
		refund = if old then math.floor(old.price * Config.ReplaceRefund) else 0
	end

	if not DataService.spend(player, def.price - refund) then
		return false, `You need {Util.formatCash(def.price - refund)}.`
	end
	profile.printers[slot] = def.id
	PrinterService.spawn(player, plot, slot, def.id)
	DataService.sync(player)
	if refund > 0 then
		return true, `Swapped in a {def.name}! (+{Util.formatCash(refund)} trade-in)`
	end
	return true, `Bought a {def.name}!`
end

local unlockKinds = {
	Blueprint = { list = Config.BlueprintById, field = "blueprints" },
	Filament = { list = Config.FilamentById, field = "filaments" },
	Upgrade = { list = Config.UpgradeById, field = "upgrades" },
}

remotes.Purchase.OnServerInvoke = function(player, kind, id)
	local profile = DataService.get(player)
	if not profile or type(kind) ~= "string" or type(id) ~= "string" then
		return false, "Bad request."
	end

	if kind == "Printer" then
		local def = Config.PrinterById[id]
		if not def then
			return false, "Unknown printer."
		end
		return buyPrinter(player, profile, def)
	end

	local info = unlockKinds[kind]
	local def = info and info.list[id]
	if not def then
		return false, "Unknown item."
	end
	if profile[info.field][id] then
		return false, "You already own that."
	end
	if not DataService.spend(player, def.price) then
		return false, `You need {Util.formatCash(def.price)}.`
	end
	profile[info.field][id] = true
	DataService.sync(player)
	return true, `Unlocked {def.name}!`
end
