local Util = {}

local SUFFIXES = { "", "K", "M", "B", "T", "Qa" }

-- 1234 -> "$1.23K"
function Util.formatCash(n: number): string
	n = math.floor(n)
	local tier = 1
	local scaled = n
	while math.abs(scaled) >= 1000 and tier < #SUFFIXES do
		scaled /= 1000
		tier += 1
	end
	if tier == 1 then
		return "$" .. tostring(n)
	end
	local text = string.format("%.2f", scaled):gsub("%.?0+$", "")
	return "$" .. text .. SUFFIXES[tier]
end

function Util.formatTime(seconds: number): string
	if seconds < 60 then
		return string.format("%.1fs", seconds)
	end
	return string.format("%dm %02ds", seconds // 60, math.floor(seconds % 60))
end

return Util
