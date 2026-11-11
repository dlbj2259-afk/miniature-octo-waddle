--[[
	UI: the whole interface is built in code so the project is pure text.
	  - HUD (cash, prints, Shop / Home buttons)
	  - Shop (Printers / Blueprints / Filaments / Upgrades)
	  - Print menu (opens when you press E on an idle printer)
	  - Toast notifications
]]

local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local TweenService = game:GetService("TweenService")

local Shared = ReplicatedStorage:WaitForChild("Shared")
local Config = require(Shared:WaitForChild("Config"))
local Util = require(Shared:WaitForChild("Util"))
local Remotes = ReplicatedStorage:WaitForChild("Remotes")

local player = Players.LocalPlayer
local profile = nil

local THEME = {
	bg = Color3.fromRGB(22, 24, 30),
	panel = Color3.fromRGB(34, 37, 46),
	card = Color3.fromRGB(46, 50, 62),
	accent = Color3.fromRGB(255, 140, 40),
	text = Color3.fromRGB(240, 242, 248),
	muted = Color3.fromRGB(160, 166, 180),
	good = Color3.fromRGB(80, 220, 120),
	bad = Color3.fromRGB(240, 90, 80),
}

--------------------------------------------------------------------------------
-- Tiny UI helpers
--------------------------------------------------------------------------------

local function make(className: string, props: { [string]: any }, children: { Instance }?)
	local inst = Instance.new(className)
	for k, v in props do
		if k ~= "Parent" then
			(inst :: any)[k] = v
		end
	end
	for _, child in children or {} do
		child.Parent = inst
	end
	inst.Parent = props.Parent
	return inst
end

local function corner(radius: number?)
	return make("UICorner", { CornerRadius = UDim.new(0, radius or 10) })
end

local function stroke(color: Color3?, thickness: number?)
	return make("UIStroke", {
		Color = color or Color3.fromRGB(70, 75, 90),
		Thickness = thickness or 1,
		ApplyStrokeMode = Enum.ApplyStrokeMode.Border,
	})
end

local function padding(px: number)
	return make("UIPadding", {
		PaddingTop = UDim.new(0, px),
		PaddingBottom = UDim.new(0, px),
		PaddingLeft = UDim.new(0, px),
		PaddingRight = UDim.new(0, px),
	})
end

local function label(props, children: { Instance }?)
	local defaults = {
		BackgroundTransparency = 1,
		Font = Enum.Font.GothamMedium,
		TextColor3 = THEME.text,
		TextSize = 16,
		TextXAlignment = Enum.TextXAlignment.Left,
	}
	for k, v in props do
		defaults[k] = v
	end
	return make("TextLabel", defaults, children)
end

local function button(props, onClick: () -> ())
	local defaults = {
		BackgroundColor3 = THEME.accent,
		Font = Enum.Font.GothamBold,
		TextColor3 = Color3.new(1, 1, 1),
		TextSize = 16,
		AutoButtonColor = true,
	}
	for k, v in props do
		defaults[k] = v
	end
	local b = make("TextButton", defaults, { corner(8) })
	b.Activated:Connect(onClick)
	return b
end

local gui = make("ScreenGui", {
	Name = "PrintTycoonUI",
	ResetOnSpawn = false,
	ZIndexBehavior = Enum.ZIndexBehavior.Sibling,
	IgnoreGuiInset = false,
	Parent = player:WaitForChild("PlayerGui"),
})

--------------------------------------------------------------------------------
-- Toasts
--------------------------------------------------------------------------------

local toastHolder = make("Frame", {
	BackgroundTransparency = 1,
	AnchorPoint = Vector2.new(0.5, 1),
	Position = UDim2.new(0.5, 0, 1, -90),
	Size = UDim2.fromOffset(420, 200),
	Parent = gui,
}, {
	make("UIListLayout", {
		VerticalAlignment = Enum.VerticalAlignment.Bottom,
		HorizontalAlignment = Enum.HorizontalAlignment.Center,
		Padding = UDim.new(0, 6),
	}),
})

local function toast(text: string, kind: string?)
	local color = if kind == "bad" then THEME.bad elseif kind == "good" then THEME.good else THEME.accent
	local t = label({
		Text = text,
		TextXAlignment = Enum.TextXAlignment.Center,
		TextWrapped = true,
		Font = Enum.Font.GothamBold,
		BackgroundTransparency = 0.1,
		BackgroundColor3 = THEME.bg,
		AutomaticSize = Enum.AutomaticSize.Y,
		Size = UDim2.new(1, 0, 0, 0),
		Parent = toastHolder,
	}, { corner(8), stroke(color, 2), padding(10) })
	task.delay(3, function()
		TweenService:Create(t, TweenInfo.new(0.4), { TextTransparency = 1, BackgroundTransparency = 1 }):Play()
		local s = t:FindFirstChildOfClass("UIStroke")
		if s then
			TweenService:Create(s, TweenInfo.new(0.4), { Transparency = 1 }):Play()
		end
		task.wait(0.45)
		t:Destroy()
	end)
end

Remotes:WaitForChild("Notify").OnClientEvent:Connect(toast)

--------------------------------------------------------------------------------
-- HUD
--------------------------------------------------------------------------------

local hud = make("Frame", {
	BackgroundColor3 = THEME.bg,
	BackgroundTransparency = 0.15,
	Position = UDim2.fromOffset(16, 16),
	Size = UDim2.fromOffset(230, 74),
	Parent = gui,
}, { corner(12), stroke(THEME.accent, 2), padding(10) })

local cashLabel = label({
	Text = "$0",
	Font = Enum.Font.GothamBlack,
	TextSize = 28,
	TextColor3 = THEME.good,
	Size = UDim2.new(1, 0, 0, 30),
	Parent = hud,
})
local printsLabel = label({
	Text = "0 prints sold",
	TextColor3 = THEME.muted,
	TextSize = 14,
	Position = UDim2.fromOffset(0, 34),
	Size = UDim2.new(1, 0, 0, 18),
	Parent = hud,
})

local bottomBar = make("Frame", {
	BackgroundTransparency = 1,
	AnchorPoint = Vector2.new(0.5, 1),
	Position = UDim2.new(0.5, 0, 1, -16),
	Size = UDim2.fromOffset(300, 54),
	Parent = gui,
}, {
	make("UIListLayout", {
		FillDirection = Enum.FillDirection.Horizontal,
		HorizontalAlignment = Enum.HorizontalAlignment.Center,
		Padding = UDim.new(0, 12),
	}),
})

--------------------------------------------------------------------------------
-- Panels
--------------------------------------------------------------------------------

local function panel(titleText: string, size: UDim2)
	local frame = make("Frame", {
		BackgroundColor3 = THEME.panel,
		AnchorPoint = Vector2.new(0.5, 0.5),
		Position = UDim2.fromScale(0.5, 0.5),
		Size = size,
		Visible = false,
		Parent = gui,
	}, {
		corner(14),
		stroke(THEME.accent, 2),
	})
	local title = label({
		Text = titleText,
		Font = Enum.Font.GothamBlack,
		TextSize = 22,
		Position = UDim2.fromOffset(18, 12),
		Size = UDim2.new(1, -80, 0, 30),
		Parent = frame,
	})
	button({
		Text = "X",
		BackgroundColor3 = THEME.bad,
		AnchorPoint = Vector2.new(1, 0),
		Position = UDim2.new(1, -12, 0, 12),
		Size = UDim2.fromOffset(32, 32),
		Parent = frame,
	}, function()
		frame.Visible = false
	end)
	return frame, title
end

-- Scale panels down on small (phone) screens.
local function fitToScreen(frame: Frame)
	local camera = workspace.CurrentCamera
	local full = frame.Size
	local function update()
		local view = camera.ViewportSize
		local maxW, maxH = view.X - 24, view.Y - 140
		frame.Size = UDim2.fromOffset(math.min(full.X.Offset, maxW), math.min(full.Y.Offset, maxH))
	end
	camera:GetPropertyChangedSignal("ViewportSize"):Connect(update)
	update()
end

-- SHOP ------------------------------------------------------------------------

local shop, _ = panel("Print Shop", UDim2.fromOffset(560, 440))
fitToScreen(shop)

local tabs = { "Printers", "Blueprints", "Filaments", "Upgrades" }
local currentTab = "Printers"
local tabButtons = {}

local tabBar = make("Frame", {
	BackgroundTransparency = 1,
	Position = UDim2.fromOffset(18, 52),
	Size = UDim2.new(1, -36, 0, 34),
	Parent = shop,
}, {
	make("UIListLayout", {
		FillDirection = Enum.FillDirection.Horizontal,
		Padding = UDim.new(0, 8),
	}),
})

local shopList = make("ScrollingFrame", {
	BackgroundTransparency = 1,
	Position = UDim2.fromOffset(18, 96),
	Size = UDim2.new(1, -36, 1, -110),
	CanvasSize = UDim2.new(),
	AutomaticCanvasSize = Enum.AutomaticSize.Y,
	ScrollBarThickness = 6,
	BorderSizePixel = 0,
	Parent = shop,
}, {
	make("UIListLayout", { Padding = UDim.new(0, 8), SortOrder = Enum.SortOrder.LayoutOrder }),
})

local renderShop -- forward declaration

for i, name in tabs do
	tabButtons[name] = button({
		Text = name,
		LayoutOrder = i,
		TextSize = 14,
		Size = UDim2.new(0.25, -6, 1, 0),
		Parent = tabBar,
	}, function()
		currentTab = name
		renderShop()
	end)
end

local function countOwned(printerId: string)
	local n = 0
	for _, id in profile.printers do
		if id == printerId then
			n += 1
		end
	end
	return n
end

local function purchase(kind: string, id: string)
	local ok, message = Remotes.Purchase:InvokeServer(kind, id)
	toast(message, if ok then "good" else "bad")
end

local function shopCard(
	order: number,
	titleText: string,
	desc: string,
	swatch: Color3?,
	owned: boolean,
	price: number,
	onBuy
)
	local card = make("Frame", {
		BackgroundColor3 = THEME.card,
		Size = UDim2.new(1, -8, 0, 70),
		LayoutOrder = order,
		Parent = shopList,
	}, { corner(10) })

	local textX = 14
	if swatch then
		make("Frame", {
			BackgroundColor3 = swatch,
			Position = UDim2.fromOffset(12, 15),
			Size = UDim2.fromOffset(40, 40),
			Parent = card,
		}, { corner(20), stroke(Color3.new(0, 0, 0), 1) })
		textX = 62
	end

	label({
		Text = titleText,
		Font = Enum.Font.GothamBold,
		TextSize = 17,
		Position = UDim2.fromOffset(textX, 10),
		Size = UDim2.new(1, -textX - 130, 0, 22),
		Parent = card,
	})
	label({
		Text = desc,
		TextSize = 13,
		TextColor3 = THEME.muted,
		TextWrapped = true,
		TextYAlignment = Enum.TextYAlignment.Top,
		Position = UDim2.fromOffset(textX, 34),
		Size = UDim2.new(1, -textX - 130, 0, 32),
		Parent = card,
	})

	local affordable = profile.cash >= price
	button({
		Text = if owned then "Owned" elseif price == 0 then "Free" else Util.formatCash(price),
		AnchorPoint = Vector2.new(1, 0.5),
		Position = UDim2.new(1, -12, 0.5, 0),
		Size = UDim2.fromOffset(110, 40),
		BackgroundColor3 = if owned then THEME.panel elseif affordable then THEME.good else Color3.fromRGB(90, 95, 110),
		AutoButtonColor = not owned,
		Parent = card,
	}, function()
		if not owned then
			onBuy()
		end
	end)
end

function renderShop()
	if not profile then
		return
	end
	for name, b in tabButtons do
		b.BackgroundColor3 = if name == currentTab then THEME.accent else THEME.card
	end
	for _, child in shopList:GetChildren() do
		if child:IsA("Frame") then
			child:Destroy()
		end
	end

	if currentTab == "Printers" then
		for i, def in Config.Printers do
			local desc = string.format(
				"%s\n%dx%d res - x%.1f value - %d%% fail - owned: %d",
				def.description,
				def.resolution,
				def.resolution,
				def.quality,
				math.floor(def.failChance * 100 + 0.5),
				countOwned(def.id)
			)
			shopCard(i, def.name, desc, def.color, false, def.price, function()
				purchase("Printer", def.id)
			end)
		end
	elseif currentTab == "Blueprints" then
		for i, def in Config.Blueprints do
			local desc = string.format("Base value %s - complexity x%.2f", Util.formatCash(def.value), def.complexity)
			shopCard(i, def.name, desc, nil, profile.blueprints[def.id] == true, def.price, function()
				purchase("Blueprint", def.id)
			end)
		end
	elseif currentTab == "Filaments" then
		for i, def in Config.Filaments do
			local desc = string.format("x%.1f value - %s per print", def.multiplier, Util.formatCash(def.cost))
			shopCard(i, def.name, desc, def.color, profile.filaments[def.id] == true, def.price, function()
				purchase("Filament", def.id)
			end)
		end
	else
		for i, def in Config.Upgrades do
			shopCard(i, def.name, def.description, nil, profile.upgrades[def.id] == true, def.price, function()
				purchase("Upgrade", def.id)
			end)
		end
	end
end

-- PRINT MENU ------------------------------------------------------------------

local printMenu, printTitle = panel("Start a print", UDim2.fromOffset(600, 450))
fitToScreen(printMenu)

local menuSlot, menuPrinter = nil, nil
local selectedBlueprint, selectedFilament = "Cube", "PLA"

label({
	Text = "BLUEPRINT",
	Font = Enum.Font.GothamBold,
	TextSize = 13,
	TextColor3 = THEME.muted,
	Position = UDim2.fromOffset(18, 52),
	Size = UDim2.new(0.55, -24, 0, 16),
	Parent = printMenu,
})
local bpList = make("ScrollingFrame", {
	BackgroundTransparency = 1,
	Position = UDim2.fromOffset(18, 72),
	Size = UDim2.new(0.55, -24, 1, -170),
	CanvasSize = UDim2.new(),
	AutomaticCanvasSize = Enum.AutomaticSize.Y,
	ScrollBarThickness = 6,
	BorderSizePixel = 0,
	Parent = printMenu,
}, {
	make("UIGridLayout", {
		CellSize = UDim2.new(0.5, -6, 0, 44),
		CellPadding = UDim2.fromOffset(6, 6),
		SortOrder = Enum.SortOrder.LayoutOrder,
	}),
})

label({
	Text = "FILAMENT",
	Font = Enum.Font.GothamBold,
	TextSize = 13,
	TextColor3 = THEME.muted,
	Position = UDim2.new(0.55, 0, 0, 52),
	Size = UDim2.new(0.45, -18, 0, 16),
	Parent = printMenu,
})
local filList = make("ScrollingFrame", {
	BackgroundTransparency = 1,
	Position = UDim2.new(0.55, 0, 0, 72),
	Size = UDim2.new(0.45, -18, 1, -170),
	CanvasSize = UDim2.new(),
	AutomaticCanvasSize = Enum.AutomaticSize.Y,
	ScrollBarThickness = 6,
	BorderSizePixel = 0,
	Parent = printMenu,
}, {
	make("UIListLayout", { Padding = UDim.new(0, 6), SortOrder = Enum.SortOrder.LayoutOrder }),
})

local summary = label({
	Text = "",
	TextSize = 15,
	TextWrapped = true,
	RichText = true,
	Position = UDim2.new(0, 18, 1, -88),
	Size = UDim2.new(1, -200, 0, 70),
	Parent = printMenu,
})

local renderPrintMenu -- forward declaration

local printButton = button({
	Text = "PRINT!",
	Font = Enum.Font.GothamBlack,
	TextSize = 22,
	AnchorPoint = Vector2.new(1, 1),
	Position = UDim2.new(1, -18, 1, -18),
	Size = UDim2.fromOffset(160, 56),
	BackgroundColor3 = THEME.good,
	Parent = printMenu,
}, function()
	if not menuSlot then
		return
	end
	local ok, message = Remotes.StartPrint:InvokeServer(menuSlot, selectedBlueprint, selectedFilament)
	toast(message, if ok then "good" else "bad")
	if ok then
		printMenu.Visible = false
	end
end)

local function choiceButton(parent: Instance, order: number, text: string, selected: boolean, swatch: Color3?, onPick)
	local b = button({
		Text = (if swatch then "      " else "") .. text,
		TextSize = 14,
		TextXAlignment = if swatch then Enum.TextXAlignment.Left else Enum.TextXAlignment.Center,
		LayoutOrder = order,
		Size = UDim2.new(1, -8, 0, 40),
		BackgroundColor3 = if selected then THEME.accent else THEME.card,
		Parent = parent,
	}, onPick)
	if swatch then
		make("Frame", {
			BackgroundColor3 = swatch,
			Position = UDim2.fromOffset(8, 8),
			Size = UDim2.fromOffset(24, 24),
			Parent = b,
		}, { corner(12) })
	end
	if selected then
		stroke(Color3.new(1, 1, 1), 2).Parent = b
	end
	return b
end

function renderPrintMenu()
	if not profile or not menuPrinter then
		return
	end
	-- Fall back to an unlocked choice if the remembered one isn't owned.
	if not profile.blueprints[selectedBlueprint] then
		selectedBlueprint = "Cube"
	end
	if not profile.filaments[selectedFilament] then
		selectedFilament = "PLA"
	end

	for _, list in { bpList, filList } do
		for _, child in list:GetChildren() do
			if child:IsA("GuiButton") then
				child:Destroy()
			end
		end
	end

	for i, def in Config.Blueprints do
		if profile.blueprints[def.id] then
			choiceButton(bpList, i, def.name, def.id == selectedBlueprint, nil, function()
				selectedBlueprint = def.id
				renderPrintMenu()
			end)
		end
	end
	for i, def in Config.Filaments do
		if profile.filaments[def.id] then
			choiceButton(filList, i, def.name, def.id == selectedFilament, def.color, function()
				selectedFilament = def.id
				renderPrintMenu()
			end)
		end
	end

	local bp = Config.BlueprintById[selectedBlueprint]
	local fil = Config.FilamentById[selectedFilament]
	local value, cost, seconds, failChance = Config.estimate(menuPrinter, bp, fil, profile.upgrades.Spaghetti)
	summary.Text = string.format(
		'Sells for <font color="#50DC78"><b>%s</b></font>   Filament <font color="#F05A50"><b>%s</b></font>\nTime <b>~%s</b>   Fail chance <b>%d%%</b>',
		Util.formatCash(value),
		Util.formatCash(cost),
		Util.formatTime(seconds),
		math.floor(failChance * 100 + 0.5)
	)
	printButton.BackgroundColor3 = if profile.cash >= cost then THEME.good else Color3.fromRGB(90, 95, 110)
end

Remotes:WaitForChild("OpenPrintMenu").OnClientEvent:Connect(function(slot: number, printerId: string)
	menuSlot = slot
	menuPrinter = Config.PrinterById[printerId]
	printTitle.Text = "Start a print - " .. menuPrinter.name
	shop.Visible = false
	printMenu.Visible = true
	renderPrintMenu()
end)

-- Bottom buttons --------------------------------------------------------------

button({
	Text = "SHOP",
	Font = Enum.Font.GothamBlack,
	TextSize = 20,
	Size = UDim2.fromOffset(140, 50),
	LayoutOrder = 1,
	Parent = bottomBar,
}, function()
	shop.Visible = not shop.Visible
	printMenu.Visible = false
	renderShop()
end)

button({
	Text = "HOME",
	Font = Enum.Font.GothamBlack,
	TextSize = 20,
	Size = UDim2.fromOffset(140, 50),
	BackgroundColor3 = THEME.card,
	LayoutOrder = 2,
	Parent = bottomBar,
}, function()
	Remotes.GoHome:FireServer()
end)

--------------------------------------------------------------------------------
-- Profile updates
--------------------------------------------------------------------------------

local function onProfile(newProfile)
	if type(newProfile) ~= "table" then
		return
	end
	profile = newProfile
	cashLabel.Text = Util.formatCash(profile.cash)
	printsLabel.Text = `{profile.totalPrints} prints sold`
	if shop.Visible then
		renderShop()
	end
	if printMenu.Visible then
		renderPrintMenu()
	end
end

Remotes:WaitForChild("Profile").OnClientEvent:Connect(onProfile)
task.spawn(function()
	onProfile(Remotes:WaitForChild("GetProfile"):InvokeServer())
	toast("Welcome to your print farm! Walk up to a printer and press E.", "good")
end)
