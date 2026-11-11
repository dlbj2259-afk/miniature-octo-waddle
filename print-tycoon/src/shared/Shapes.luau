--[[
	Shapes: every blueprint is a solid defined by an "inside?" function.

	  inside(u, v, h) -> boolean
	    u, v : horizontal position, -1 .. 1 (X and Z across the build plate)
	    h    : height,               0 .. 1 (bottom of print to top)

	Shapes.slice() turns a shape into printable layers, the same way a real
	slicer turns an STL into G-code: each layer is a list of straight "runs"
	the nozzle draws along the X axis. Adjacent voxels are merged into a single
	run so a print only needs a few hundred parts.
]]

local Shapes = {}

local abs, sqrt, sin, cos, pi = math.abs, math.sqrt, math.sin, math.cos, math.pi

local function radius(u, v)
	return sqrt(u * u + v * v)
end

local defs = {}

defs.Cube = function(u, v, _h)
	return abs(u) <= 0.85 and abs(v) <= 0.85
end

defs.Pyramid = function(u, v, h)
	return math.max(abs(u), abs(v)) <= 0.95 * (1 - h) + 0.05
end

defs.Sphere = function(u, v, h)
	local y = h * 2 - 1
	return u * u + v * v + y * y <= 0.95
end

defs.Vase = function(u, v, h)
	local d = radius(u, v)
	local outer = 0.45 + 0.35 * sin(h * pi * 1.3)
	-- Solid base, hollow walls (like "vase mode" on a real slicer).
	return d <= outer and (h < 0.12 or d >= outer - 0.3)
end

defs.Donut = function(u, v, h)
	local d = radius(u, v)
	local tube = ((d - 0.58) / 0.38) ^ 2 + ((h - 0.5) / 0.5) ^ 2
	return tube <= 1
end

defs.Rook = function(u, v, h)
	local d = radius(u, v)
	if h < 0.12 then
		return d <= 0.9 -- flared base
	elseif h < 0.78 then
		return d <= 0.62
	end
	-- Battlements: a ring with 4 notches cut out at the top.
	if d > 0.82 or d < 0.45 then
		return false
	end
	if h < 0.88 then
		return true
	end
	local angle = math.atan2(v, u) + pi
	return math.floor(angle / (2 * pi) * 8) % 2 == 0
end

defs.Rocket = function(u, v, h)
	local d = radius(u, v)
	-- Fins (a plus shape that tapers with height).
	if h < 0.38 and (abs(u) < 0.12 or abs(v) < 0.12) and d <= 0.95 - h * 1.4 then
		return true
	end
	if h < 0.7 then
		return d <= 0.36
	end
	-- Nose cone.
	return d <= 0.36 * (1 - (h - 0.7) / 0.32)
end

defs.Heart = function(u, v, h)
	-- Classic implicit heart surface, z pointing up.
	local x = u * 1.35
	local y = v * 1.1
	local z = h * 2.35 - 1.05
	local a = x * x + 2.25 * y * y + z * z - 1
	return a * a * a - x * x * z * z * z - 0.1125 * y * y * z * z * z <= 0
end

defs.Twist = function(u, v, h)
	local angle = h * pi * 0.9
	local c, s = cos(angle), sin(angle)
	local ru = u * c - v * s
	local rv = u * s + v * c
	local half = 0.72 - 0.22 * h
	return abs(ru) <= half and abs(rv) <= half
end

Shapes.Definitions = defs

export type Run = { z: number, x0: number, x1: number }
export type Layer = { Run }

local cache: { [string]: { Layer } } = {}

-- Returns layers[1..res], each a list of runs in nozzle order (serpentine,
-- like a real printer, so the head doesn't jump back every row).
function Shapes.slice(id: string, res: number): { Layer }
	local key = id .. "@" .. res
	if cache[key] then
		return cache[key]
	end

	local inside = defs[id]
	assert(inside, "Unknown shape " .. tostring(id))

	local layers = {}
	for y = 1, res do
		local h = (y - 0.5) / res
		local layer = {}
		for z = 1, res do
			local v = (z - 0.5) / res * 2 - 1
			local rowRuns = {}
			local start = nil
			for x = 1, res + 1 do
				local filled = false
				if x <= res then
					local u = (x - 0.5) / res * 2 - 1
					filled = inside(u, v, h)
				end
				if filled and not start then
					start = x
				elseif not filled and start then
					table.insert(rowRuns, { z = z, x0 = start, x1 = x - 1 })
					start = nil
				end
			end
			-- Serpentine: odd rows go left->right, even rows right->left.
			if z % 2 == 0 then
				for i = #rowRuns, 1, -1 do
					local r = rowRuns[i]
					table.insert(layer, { z = r.z, x0 = r.x1, x1 = r.x0 })
				end
			else
				for _, r in rowRuns do
					table.insert(layer, r)
				end
			end
		end
		layers[y] = layer
	end

	-- Trim empty layers at the bottom (so nothing prints in mid-air) and at
	-- the top (so the printer doesn't waste time on thin tips).
	while #layers > 0 and #layers[1] == 0 do
		table.remove(layers, 1)
	end
	while #layers > 0 and #layers[#layers] == 0 do
		table.remove(layers)
	end

	cache[key] = layers
	return layers
end

return Shapes
