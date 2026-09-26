-- Set the AirPods listening mode through the Sound menu of Control Center.
--
--   osascript anc.applescript <mode> [<other mode>] [<device name>] [auto|off|adaptive]
--
-- <mode> and <other mode> are Off, Transparency, Adaptive or Noise Cancellation. With <other mode>
-- it toggles: <mode> is selected unless it already is, in which case <other mode> is.
-- Prints ok:<previous mode>:<new mode> or error:<code>. Needs Accessibility permission.
--
-- macOS has no public API for listening modes (IOBluetoothDevice's private setListeningMode: no
-- longer reaches the AirPods on recent macOS), so this drives the Sound menu the way a person would.
-- To stay independent of the system language it never matches localised text:
--   * the Sound menu extra is found by its AXIdentifier "com.apple.menuextra.sound",
--     or through Control Center's "controlcenter-volume" tile when Sound isn't in the menu bar;
--   * the Listening Mode rows are found by structure: the first run of 3-4 checkboxes that follows
--     a heading of the selected output device. English labels are only used to confirm the order.
-- All data arrives as argv, never interpolated into code.

property englishModes : {"Off", "Transparency", "Adaptive", "Noise Cancellation"}

on run argv
	set wantA to item 1 of argv
	set wantB to ""
	if (count of argv) > 1 then set wantB to item 2 of argv
	set deviceName to ""
	if (count of argv) > 2 then set deviceName to item 3 of argv
	set threeLayout to "auto"
	if (count of argv) > 3 then set threeLayout to item 4 of argv

	try
		tell application "System Events" to count UI elements of process "ControlCenter"
	on error errMsg number errNum
		if errMsg contains "assistive" or errNum is -25211 or errNum is -1719 then return "error:accessibility"
		return "error:no-sound-item"
	end try

	set opener to my openSoundMenu()
	if opener is missing value then return "error:no-sound-item"
	set sa to my waitForScrollArea()
	if sa is missing value then
		my closeMenu(opener)
		return "error:no-popover"
	end if

	set rows to my listeningRows(sa, deviceName)
	if (count of rows) < 2 then
		-- the selected device may be collapsed: expand it and look again
		if my expandDevice(sa, deviceName) then
			delay 0.4
			set rows to my listeningRows(sa, deviceName)
		end if
	end if
	if (count of rows) < 2 then
		my closeMenu(opener)
		return "error:no-modes"
	end if

	set modeNames to my namesFor(rows, deviceName, threeLayout)
	set previous to ""
	repeat with i from 1 to count of rows
		if my isOn(item i of rows) then set previous to item i of modeNames
	end repeat

	set target to wantA
	if wantB is not "" and previous is wantA then set target to wantB
	set targetIndex to 0
	repeat with i from 1 to count of modeNames
		if item i of modeNames is target then set targetIndex to i
	end repeat
	if targetIndex is 0 then
		my closeMenu(opener)
		return "error:unavailable"
	end if

	if previous is not target then
		tell application "System Events" to click (item targetIndex of rows)
		set ok to false
		repeat 10 times
			delay 0.1
			if my isOn(item targetIndex of rows) then
				set ok to true
				exit repeat
			end if
		end repeat
		if not ok then
			my closeMenu(opener)
			return "error:click-failed"
		end if
	end if
	my closeMenu(opener)
	return "ok:" & previous & ":" & target
end run

-- Breadth-first search below root for an element whose AXIdentifier (key "id") or role (key "role")
-- is wanted. Bounded by depth and a node budget: some accessibility trees contain cycles.
property budget : 0

on findIn(root, key, wanted, depth)
	if depth < 0 or budget is less than or equal to 0 then return missing value
	set budget to budget - 1
	tell application "System Events"
		set kids to {}
		try
			set kids to UI elements of root
		end try
		repeat with k in kids
			set v to ""
			try
				if key is "id" then
					set v to value of attribute "AXIdentifier" of k
				else
					set v to role of k
				end if
			end try
			if v is wanted then return contents of k
		end repeat
		repeat with k in kids
			set r to my findIn(contents of k, key, wanted, depth - 1)
			if r is not missing value then return r
		end repeat
	end tell
	return missing value
end findIn

-- The menu extra with this AXIdentifier, in the processes that host menu extras
-- (Control Center up to macOS 26, MenuBarAgent on macOS 27).
on findMenuExtra(wanted)
	tell application "System Events"
		repeat with procName in {"ControlCenter", "MenuBarAgent", "SystemUIServer"}
			if exists process (contents of procName) then
				set p to process (contents of procName)
				try
					repeat with mb in (every menu bar of p)
						repeat with mi in (every menu bar item of mb)
							try
								if (value of attribute "AXIdentifier" of mi) is wanted then return contents of mi
							end try
						end repeat
					end repeat
				end try
				set my budget to 300
				set r to my findIn(p, "id", wanted, 4)
				if r is not missing value then return r
			end if
		end repeat
	end tell
	return missing value
end findMenuExtra

on press(el)
	tell application "System Events"
		try
			perform action "AXPress" of el
		on error
			click el
		end try
	end tell
end press

-- Opens the Sound menu; returns the element to press again to close it, or missing value.
on openSoundMenu()
	set soundItem to my findMenuExtra("com.apple.menuextra.sound")
	if soundItem is not missing value then
		my press(soundItem)
		return soundItem
	end if
	-- Sound isn't in the menu bar: go through Control Center's Sound tile
	set ccItem to my findMenuExtra("com.apple.menuextra.controlcenter")
	if ccItem is missing value then return missing value
	my press(ccItem)
	tell application "System Events" to tell process "ControlCenter"
		repeat 20 times
			if (count of windows) > 0 then exit repeat
			delay 0.1
		end repeat
		if (count of windows) is 0 then return missing value
		set my budget to 400
		set tile to my findIn(window 1, "id", "controlcenter-volume", 6)
		if tile is missing value then
			my closeMenu(ccItem)
			return missing value
		end if
		-- prefer the "show details" action, which expands the tile instead of toggling it
		set done to false
		try
			repeat with a in (actions of tile)
				if (name of a) contains "ShowDetails" or (name of a) contains "show details" then
					perform a
					set done to true
					exit repeat
				end if
			end repeat
		end try
		if not done then my press(tile)
	end tell
	return ccItem
end openSoundMenu

on waitForScrollArea()
	tell application "System Events" to tell process "ControlCenter"
		repeat 30 times
			try
				if (count of windows) > 0 then
					set my budget to 400
					set sa to my findIn(window 1, "role", "AXScrollArea", 6)
					if sa is not missing value then
						-- rows render after the window appears: wait for a stable count
						set prev to -1
						repeat 20 times
							set n to count of UI elements of sa
							if n > 0 and n is prev then exit repeat
							set prev to n
							delay 0.1
						end repeat
						return sa
					end if
				end if
			end try
			delay 0.1
		end repeat
	end tell
	return missing value
end waitForScrollArea

on isOn(cb)
	tell application "System Events"
		try
			return ((value of cb) as integer) is 1
		on error
			return false
		end try
	end tell
end isOn

on identifierOf(el)
	tell application "System Events"
		try
			set i to value of attribute "AXIdentifier" of el
			if i is missing value then return ""
			return i as text
		on error
			return ""
		end try
	end tell
end identifierOf

on labelOf(el)
	tell application "System Events"
		repeat with k in {"AXDescription", "AXTitle"}
			try
				set v to value of attribute (contents of k) of el
				if v is not missing value and (v as text) is not "" then return v as text
			end try
		end repeat
	end tell
	return ""
end labelOf

-- Checkboxes of the Listening Mode section, in on-screen order.
on listeningRows(sa, deviceName)
	tell application "System Events"
		set els to UI elements of sa
		set n to count of els
		repeat with i from 1 to n
			set el to item i of els
			set r to ""
			try
				set r to role of el
			end try
			if r is "AXHeading" and my identifierOf(el) is not "" then
				set seq to {}
				repeat with j from (i + 1) to n
					set c to item j of els
					set cr to ""
					try
						set cr to role of c
					end try
					if cr is "AXCheckBox" then
						set end of seq to c
					else
						exit repeat
					end if
				end repeat
				if (count of seq) is greater than or equal to 3 and (count of seq) is less than or equal to 4 then return seq
			end if
		end repeat
		-- fallback: checkboxes carrying English mode names
		set found to {}
		repeat with el in els
			try
				if (role of el) is "AXCheckBox" and englishModes contains my labelOf(el) then set end of found to contents of el
			end try
		end repeat
		return found
	end tell
end listeningRows

-- The mode name of each row: from English labels when present, else from the row count.
on namesFor(rows, deviceName, threeLayout)
	set names to {}
	set allEnglish to true
	repeat with r in rows
		set l to my labelOf(r)
		if englishModes contains l then
			set end of names to l
		else
			set allEnglish to false
		end if
	end repeat
	if allEnglish then return names
	set n to count of rows
	if n is 4 then return {"Off", "Transparency", "Adaptive", "Noise Cancellation"}
	if n is 3 then
		if threeLayout is "off" or (threeLayout is "auto" and deviceName contains "Max") then return {"Off", "Transparency", "Noise Cancellation"}
		return {"Transparency", "Adaptive", "Noise Cancellation"}
	end if
	return {"Transparency", "Noise Cancellation"}
end namesFor

-- Click the disclosure triangle of the selected output device if it is collapsed.
on expandDevice(sa, deviceName)
	tell application "System Events"
		set els to UI elements of sa
		repeat with i from 1 to count of els
			set el to item i of els
			set ident to my identifierOf(el)
			if ident starts with "sound-device-" then
				set selectedRow to false
				try
					set selectedRow to (role of el) is "AXCheckBox" and my isOn(el)
				end try
				if selectedRow and (deviceName is "" or ident is ("sound-device-" & deviceName)) then
					repeat with j from (i + 1) to (i + 3)
						if j > (count of els) then exit repeat
						set t to item j of els
						try
							if (role of t) is "AXDisclosureTriangle" then
								if not my isOn(t) then
									click t
									return true
								end if
								return false
							end if
						end try
					end repeat
					-- the triangle can also come before the row
					if i > 1 then
						set t to item (i - 1) of els
						try
							if (role of t) is "AXDisclosureTriangle" and not my isOn(t) then
								click t
								return true
							end if
						end try
					end if
				end if
			end if
		end repeat
	end tell
	return false
end expandDevice

on closeMenu(opener)
	delay 0.3
	tell application "System Events" to tell process "ControlCenter"
		repeat 5 times
			if (count of windows) is 0 then exit repeat
			my press(opener)
			delay 0.3
		end repeat
		if (count of windows) > 0 then key code 53 -- Escape
	end tell
end closeMenu
