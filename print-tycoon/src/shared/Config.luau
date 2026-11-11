--[[
	Config: every tunable number in the game lives here.
	Shared by server (authoritative) and client (for showing prices / estimates).
]]

local Config = {}

Config.StartingCash = 25
Config.PlotCount = 6
Config.SlotsPerPlot = 6
Config.AutoSaveInterval = 60
Config.FailedPrintPayout = 0.1 -- spaghetti sells for 10% of value
Config.ReplaceRefund = 0.5 -- refund when a printer is swapped out for a new one

--------------------------------------------------------------------------------
-- Printers: bought with cash, placed on plot slots.
--   resolution  = voxels per side (higher = smoother prints, more layers)
--   buildSize   = studs per side of the printed object
--   layerTime   = seconds per layer (before blueprint complexity)
--   quality     = sale value multiplier
--   failChance  = chance a print turns into spaghetti
--------------------------------------------------------------------------------
Config.Printers = {
	{
		id = "Starter",
		name = "Starter FDM",
		description = "Wobbly but loyal. Everyone starts somewhere.",
		price = 0,
		resolution = 8,
		buildSize = 4,
		layerTime = 1.0,
		quality = 1.0,
		failChance = 0.12,
		color = Color3.fromRGB(70, 130, 220),
	},
	{
		id = "ProFDM",
		name = "Pro FDM",
		description = "Auto bed levelling! Finer layers, fewer fails.",
		price = 600,
		resolution = 10,
		buildSize = 5,
		layerTime = 0.75,
		quality = 1.6,
		failChance = 0.06,
		color = Color3.fromRGB(230, 120, 40),
	},
	{
		id = "Resin",
		name = "Resin SLA",
		description = "Liquid resin cured by UV light. Super detailed.",
		price = 4000,
		resolution = 14,
		buildSize = 5,
		layerTime = 0.5,
		quality = 2.6,
		failChance = 0.03,
		color = Color3.fromRGB(150, 70, 210),
		enclosure = Color3.fromRGB(255, 150, 40),
	},
	{
		id = "Industrial",
		name = "Industrial Fab",
		description = "Huge build volume, never fails, prints fast.",
		price = 22000,
		resolution = 18,
		buildSize = 7,
		layerTime = 0.32,
		quality = 4.5,
		failChance = 0,
		color = Color3.fromRGB(40, 40, 45),
		enclosure = Color3.fromRGB(170, 220, 255),
	},
}

--------------------------------------------------------------------------------
-- Blueprints: the models you can print. Shapes are defined in Shapes.luau.
--------------------------------------------------------------------------------
Config.Blueprints = {
	{ id = "Cube", name = "Calibration Cube", price = 0, value = 8, complexity = 1.0 },
	{ id = "Pyramid", name = "Pyramid", price = 80, value = 13, complexity = 1.0 },
	{ id = "Sphere", name = "Sphere", price = 250, value = 22, complexity = 1.15 },
	{ id = "Vase", name = "Spiral Vase", price = 600, value = 34, complexity = 1.25 },
	{ id = "Donut", name = "Donut", price = 1500, value = 55, complexity = 1.3 },
	{ id = "Rook", name = "Castle Rook", price = 3500, value = 85, complexity = 1.4 },
	{ id = "Rocket", name = "Rocket", price = 8000, value = 140, complexity = 1.5 },
	{ id = "Heart", name = "Heart", price = 18000, value = 230, complexity = 1.6 },
	{ id = "Twist", name = "Twisted Tower", price = 40000, value = 380, complexity = 1.7 },
}

--------------------------------------------------------------------------------
-- Filaments: what the print is made of. `cost` is paid every print.
--------------------------------------------------------------------------------
Config.Filaments = {
	{
		id = "PLA",
		name = "Basic PLA",
		price = 0,
		cost = 1,
		multiplier = 1.0,
		color = Color3.fromRGB(235, 235, 235),
		material = Enum.Material.SmoothPlastic,
	},
	{
		id = "PETG",
		name = "Ocean PETG",
		price = 150,
		cost = 3,
		multiplier = 1.4,
		color = Color3.fromRGB(40, 150, 230),
		material = Enum.Material.Glass,
		transparency = 0.15,
	},
	{
		id = "Silk",
		name = "Silk Copper",
		price = 1200,
		cost = 8,
		multiplier = 2.1,
		color = Color3.fromRGB(205, 120, 70),
		material = Enum.Material.Metal,
	},
	{
		id = "Glow",
		name = "Glow-in-the-Dark",
		price = 3500,
		cost = 15,
		multiplier = 2.9,
		color = Color3.fromRGB(120, 255, 140),
		material = Enum.Material.Neon,
	},
	{
		id = "Carbon",
		name = "Carbon Fiber",
		price = 9000,
		cost = 25,
		multiplier = 3.8,
		color = Color3.fromRGB(45, 45, 50),
		material = Enum.Material.Slate,
	},
	{
		id = "Gold",
		name = "Gold Fill",
		price = 25000,
		cost = 60,
		multiplier = 5.5,
		color = Color3.fromRGB(255, 200, 60),
		material = Enum.Material.Foil,
	},
}

--------------------------------------------------------------------------------
-- Upgrades: one-time purchases that automate the farm.
--------------------------------------------------------------------------------
Config.Upgrades = {
	{
		id = "AutoSell",
		name = "Conveyor Collector",
		description = "Finished prints are sold automatically.",
		price = 2000,
	},
	{
		id = "AutoRepeat",
		name = "Print Queue",
		description = "Printers restart their last job after selling.",
		price = 5000,
	},
	{
		id = "Spaghetti",
		name = "Spaghetti Detector",
		description = "Halves the fail chance of every printer.",
		price = 7500,
	},
}

-- Lookup tables: Config.PrinterById.Starter, etc.
local function index(list)
	local map = {}
	for order, item in list do
		item.order = order
		map[item.id] = item
	end
	return map
end

Config.PrinterById = index(Config.Printers)
Config.BlueprintById = index(Config.Blueprints)
Config.FilamentById = index(Config.Filaments)
Config.UpgradeById = index(Config.Upgrades)

-- Shared formula so the UI estimate always matches what the server pays out.
function Config.estimate(printer, blueprint, filament, hasDetector: boolean?)
	local value = math.floor(blueprint.value * filament.multiplier * printer.quality + 0.5)
	local seconds = printer.resolution * printer.layerTime * blueprint.complexity
	local failChance = printer.failChance * (if hasDetector then 0.5 else 1)
	return value, filament.cost, seconds, failChance
end

return Config
