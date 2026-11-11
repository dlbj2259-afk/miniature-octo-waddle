--[[
	PlotService: builds the print-farm plots and hands one to each player.

	Plot local space: -Z (the plot's LookVector) faces the middle of the map,
	where the player spawns. Printer slots sit in two rows behind the spawn.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Config = require(ReplicatedStorage.Shared.Config)

local PlotService = {}

local PLOT_SIZE = 64
local plots = {}
local world: Folder

local function part(props)
	local p = Instance.new("Part")
	p.Anchored = true
	p.TopSurface = Enum.SurfaceType.Smooth
	p.BottomSurface = Enum.SurfaceType.Smooth
	for k, v in props do
		if k ~= "Parent" then
			(p :: any)[k] = v
		end
	end
	p.Parent = props.Parent
	return p
end

local function slotOffsets()
	-- 3 columns x N rows, front row first.
	local offsets = {}
	local columns = { -18, 0, 18 }
	local row = 0
	while #offsets < Config.SlotsPerPlot do
		for _, x in columns do
			if #offsets < Config.SlotsPerPlot then
				table.insert(offsets, Vector3.new(x, 0, 2 + row * 17))
			end
		end
		row += 1
	end
	return offsets
end

local function setSign(plot, text: string)
	plot.signLabel.Text = text
end

local function buildPlot(index: number, cf: CFrame)
	local folder = Instance.new("Folder")
	folder.Name = "Plot" .. index
	folder.Parent = world

	part({
		Name = "Floor",
		Size = Vector3.new(PLOT_SIZE, 1, PLOT_SIZE),
		CFrame = cf * CFrame.new(0, -0.4, 0),
		Color = Color3.fromRGB(200, 200, 205),
		Material = Enum.Material.Concrete,
		Parent = folder,
	})

	-- Coloured trim around the edge.
	local trimColor = Color3.fromHSV((index - 1) / Config.PlotCount, 0.6, 0.95)
	for _, edge in
		{
			{ 0, PLOT_SIZE / 2, PLOT_SIZE, 1 },
			{ 0, -PLOT_SIZE / 2, PLOT_SIZE, 1 },
			{ PLOT_SIZE / 2, 0, 1, PLOT_SIZE },
			{ -PLOT_SIZE / 2, 0, 1, PLOT_SIZE },
		}
	do
		part({
			Name = "Trim",
			Size = Vector3.new(edge[3], 0.4, edge[4]),
			CFrame = cf * CFrame.new(edge[1], 0.25, edge[2]),
			Color = trimColor,
			Material = Enum.Material.Neon,
			Parent = folder,
		})
	end

	-- Sign at the back of the plot, facing the centre of the map.
	local sign = part({
		Name = "Sign",
		Size = Vector3.new(30, 7, 1),
		CFrame = cf * CFrame.new(0, 16, PLOT_SIZE / 2 - 1),
		Color = Color3.fromRGB(30, 32, 40),
		Parent = folder,
	})
	for _, x in { -12, 12 } do
		part({
			Name = "SignPost",
			Size = Vector3.new(1, 13, 1),
			CFrame = cf * CFrame.new(x, 6.5, PLOT_SIZE / 2 - 1),
			Color = Color3.fromRGB(30, 32, 40),
			Parent = folder,
		})
	end
	local surface = Instance.new("SurfaceGui")
	surface.Face = Enum.NormalId.Front
	surface.PixelsPerStud = 30
	surface.SizingMode = Enum.SurfaceGuiSizingMode.PixelsPerStud
	surface.Parent = sign
	local label = Instance.new("TextLabel")
	label.Size = UDim2.fromScale(1, 1)
	label.BackgroundTransparency = 1
	label.Font = Enum.Font.GothamBlack
	label.TextScaled = true
	label.TextColor3 = trimColor
	label.Text = "Empty Print Farm"
	label.Parent = surface
	local pad = Instance.new("UIPadding")
	pad.PaddingTop = UDim.new(0.15, 0)
	pad.PaddingBottom = UDim.new(0.15, 0)
	pad.PaddingLeft = UDim.new(0.05, 0)
	pad.PaddingRight = UDim.new(0.05, 0)
	pad.Parent = label

	-- Faint pads showing where printers go.
	local slots = {}
	for i, offset in slotOffsets() do
		local slotCF = cf * CFrame.new(offset)
		part({
			Name = "SlotPad" .. i,
			Size = Vector3.new(11, 0.2, 11),
			CFrame = slotCF * CFrame.new(0, 0.1, 0),
			Color = Color3.fromRGB(160, 160, 170),
			Material = Enum.Material.DiamondPlate,
			Transparency = 0.3,
			CanCollide = false,
			Parent = folder,
		})
		slots[i] = slotCF
	end

	local printersFolder = Instance.new("Folder")
	printersFolder.Name = "Printers"
	printersFolder.Parent = folder

	return {
		index = index,
		cframe = cf,
		folder = folder,
		printersFolder = printersFolder,
		slots = slots,
		spawn = cf * CFrame.new(0, 4, -PLOT_SIZE / 2 + 6) * CFrame.Angles(0, math.pi, 0),
		signLabel = label,
		owner = nil :: Player?,
	}
end

function PlotService.build()
	world = Instance.new("Folder")
	world.Name = "PrintFarms"
	world.Parent = workspace

	-- Plots in two rows facing a central walkway.
	local perRow = math.ceil(Config.PlotCount / 2)
	local spacing = PLOT_SIZE + 16
	for i = 1, Config.PlotCount do
		local rowIndex = (i - 1) // perRow -- 0 or 1
		local col = (i - 1) % perRow
		local x = (col - (perRow - 1) / 2) * spacing
		local z = if rowIndex == 0 then -(PLOT_SIZE / 2 + 12) else (PLOT_SIZE / 2 + 12)
		local pos = Vector3.new(x, 0, z)
		local cf = CFrame.lookAt(pos, Vector3.new(x, 0, 0))
		plots[i] = buildPlot(i, cf)
	end

	-- Central spawn pad.
	local spawn = Instance.new("SpawnLocation")
	spawn.Anchored = true
	spawn.Size = Vector3.new(12, 1, 12)
	spawn.Position = Vector3.new(0, 0.1, 0)
	spawn.Color = Color3.fromRGB(255, 140, 40)
	spawn.Material = Enum.Material.Neon
	spawn.Neutral = true
	spawn.Duration = 0
	spawn.Parent = world
end

function PlotService.claim(player: Player)
	for _, plot in plots do
		if not plot.owner then
			plot.owner = player
			setSign(plot, player.DisplayName .. "'s Print Farm")
			return plot
		end
	end
	return nil
end

function PlotService.release(player: Player)
	for _, plot in plots do
		if plot.owner == player then
			plot.owner = nil
			setSign(plot, "Empty Print Farm")
		end
	end
end

function PlotService.get(player: Player)
	for _, plot in plots do
		if plot.owner == player then
			return plot
		end
	end
	return nil
end

function PlotService.teleportHome(player: Player)
	local plot = PlotService.get(player)
	local character = player.Character
	if plot and character then
		character:PivotTo(plot.spawn)
	end
end

return PlotService
