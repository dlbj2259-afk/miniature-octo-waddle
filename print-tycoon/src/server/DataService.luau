--[[
	DataService: loads/saves each player's profile and keeps cash in sync with
	leaderstats and the client UI.
]]

local DataStoreService = game:GetService("DataStoreService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Config = require(ReplicatedStorage.Shared.Config)

local DataService = {}

local STORE_NAME = "PrintTycoon_v1"
local store = nil
do
	local ok, result = pcall(function()
		return DataStoreService:GetDataStore(STORE_NAME)
	end)
	if ok then
		store = result
	else
		warn("[DataService] DataStores unavailable (enable Studio API access to save):", result)
	end
end

local profiles: { [Player]: any } = {}
local canSave: { [Player]: boolean } = {}
local loadedSignals: { [Player]: BindableEvent } = {}

local function defaultProfile()
	return {
		cash = Config.StartingCash,
		totalPrints = 0,
		printers = { "Starter" }, -- index = plot slot
		blueprints = { Cube = true },
		filaments = { PLA = true },
		upgrades = {},
	}
end

-- Fill in any fields added in later versions of the game.
local function reconcile(data)
	local default = defaultProfile()
	for key, value in default do
		if data[key] == nil then
			data[key] = value
		end
	end
	return data
end

local function key(player: Player)
	return "player_" .. player.UserId
end

function DataService.load(player: Player)
	local data = nil
	local ok = true
	if store then
		ok = false
		for attempt = 1, 3 do
			local success, result = pcall(function()
				return store:GetAsync(key(player))
			end)
			if success then
				ok = true
				data = result
				break
			end
			warn(`[DataService] Load attempt {attempt} failed for {player.Name}: {result}`)
			task.wait(attempt)
		end
	end

	-- If loading errored, play with a fresh profile but never overwrite the save.
	canSave[player] = store ~= nil and ok
	local profile = reconcile(if type(data) == "table" then data else defaultProfile())
	profiles[player] = profile

	local leaderstats = Instance.new("Folder")
	leaderstats.Name = "leaderstats"
	local cash = Instance.new("NumberValue")
	cash.Name = "Cash"
	cash.Value = profile.cash
	cash.Parent = leaderstats
	local prints = Instance.new("IntValue")
	prints.Name = "Prints"
	prints.Value = profile.totalPrints
	prints.Parent = leaderstats
	leaderstats.Parent = player

	if loadedSignals[player] then
		loadedSignals[player]:Fire()
	end
	return profile
end

function DataService.get(player: Player)
	return profiles[player]
end

-- Yields until the profile has loaded (or the player leaves).
-- The signal fires once on load (or on leave), so a single wait is enough.
function DataService.waitFor(player: Player)
	if profiles[player] then
		return profiles[player]
	end
	local signal = loadedSignals[player] or Instance.new("BindableEvent")
	loadedSignals[player] = signal
	signal.Event:Wait()
	return profiles[player]
end

local remotes = nil
function DataService.setRemotes(r)
	remotes = r
end

-- Push the profile to leaderstats + the player's UI.
function DataService.sync(player: Player)
	local profile = profiles[player]
	if not profile then
		return
	end
	local leaderstats = player:FindFirstChild("leaderstats")
	if leaderstats then
		leaderstats.Cash.Value = profile.cash
		leaderstats.Prints.Value = profile.totalPrints
	end
	if remotes then
		remotes.Profile:FireClient(player, profile)
	end
end

function DataService.addCash(player: Player, amount: number)
	local profile = profiles[player]
	if profile then
		profile.cash += amount
		DataService.sync(player)
	end
end

function DataService.spend(player: Player, amount: number): boolean
	local profile = profiles[player]
	if not profile or profile.cash < amount then
		return false
	end
	profile.cash -= amount
	DataService.sync(player)
	return true
end

function DataService.save(player: Player)
	local profile = profiles[player]
	if not profile or not canSave[player] then
		return
	end
	local ok, err = pcall(function()
		store:SetAsync(key(player), profile)
	end)
	if not ok then
		warn(`[DataService] Save failed for {player.Name}: {err}`)
	end
end

function DataService.release(player: Player)
	DataService.save(player)
	profiles[player] = nil
	canSave[player] = nil
	if loadedSignals[player] then
		loadedSignals[player]:Fire()
		loadedSignals[player]:Destroy()
		loadedSignals[player] = nil
	end
end

function DataService.saveAll()
	for player in profiles do
		task.spawn(DataService.save, player)
	end
end

function DataService.start()
	task.spawn(function()
		while true do
			task.wait(Config.AutoSaveInterval)
			DataService.saveAll()
		end
	end)
	game:BindToClose(function()
		for player in profiles do
			DataService.save(player)
		end
	end)
end

return DataService
