-- Set the AirPods listening mode through the Sound menu of Control Center.
--
--   osascript anc.applescript <mode> [<other mode>] [<device name>] [auto|off|adaptive] [<labels>] [<other labels>]
--
-- <mode> and <other mode> are Off, Transparency, Adaptive or Noise Cancellation. With <other mode>
-- it toggles: <mode> is selected unless it already is, in which case <other mode> is.
-- Prints ok:<previous mode>:<new mode> or error:<code>. Needs Accessibility permission.
--
-- macOS has no public API for listening modes (IOBluetoothDevice's private setListeningMode: no
-- longer reaches the AirPods on recent macOS), so this drives the Sound menu the way a person would.
-- To stay independent of the system language:
--   * the Sound menu extra is found by its AXIdentifier "com.apple.menuextra.sound",
--     or through Control Center's "controlcenter-volume" tile when Sound isn't in the menu bar;
--   * the Listening Mode rows are found by structure: below the selected output device's row, the
--     first run of 3-4 checkboxes after a heading. Their labels confirm the run (and rule out Spatial
--     Audio's Off / Fixed / Head Tracked) and name the modes: <labels> are Control Center's own words
--     for Off, Transparency, Adaptive and Noise Cancellation in the current language, and <other
--     labels> its words for Fixed, Head Tracked and Spatialize Stereo (tab-separated, read from its
--     string tables by displayaudio.js). English names always work too.
-- All data arrives as argv, never interpolated into code.

property englishModes : {"Off", "Transparency", "Adaptive", "Noise Cancellation"}
property englishOther : {"Fixed", "Head Tracked", "Head-Tracked", "Spatialize Stereo"}
-- localised labels (see setLabels); "" where unknown
property modeLabels : {"", "", "", ""}
property otherLabels : {}

on splitTabs(t)
	if t is "" then return {}
	set saved to AppleScript's text item delimiters
	set AppleScript's text item delimiters to tab
	set parts to text items of t
	set AppleScript's text item delimiters to saved
	return parts
end splitTabs

on setLabels(modesText, otherText)
	set modeLabels to {"", "", "", ""}
	set parts to my splitTabs(modesText)
	if (count of parts) is 4 then set modeLabels to parts
	set otherLabels to {}
	repeat with p in my splitTabs(otherText)
		if (contents of p) is not "" then set end of otherLabels to (contents of p)
	end repeat
end setLabels

-- The English name of a listening-mode label, or "" when it isn't one.
on modeKey(l)
	if l is "" then return ""
	repeat with i from 1 to 4
		if (item i of modeLabels) is not "" and l is (item i of modeLabels) then return item i of englishModes
	end repeat
	if englishModes contains l then return l
	return ""
end modeKey

on isOtherLabel(l)
	if l is "" then return false
	return (englishOther contains l) or (otherLabels contains l)
end isOtherLabel

on run argv
	set wantA to item 1 of argv
	set wantB to ""
	if (count of argv) > 1 then set wantB to item 2 of argv
	set deviceName to ""
	if (count of argv) > 2 then set deviceName to item 3 of argv
	set threeLayout to "auto"
	if (count of argv) > 3 then set threeLayout to item 4 of argv
	set labelText to ""
	set otherText to ""
	if (count of argv) > 4 then set labelText to item 5 of argv
	if (count of argv) > 5 then set otherText to item 6 of argv
	my setLabels(labelText, otherText)

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

	set {rows, modeNames} to my listeningRows(sa, deviceName, threeLayout)
	if (count of rows) < 2 then
		-- the selected device may be collapsed: expand it and look again
		if my expandDevice(sa, deviceName) then
			delay 0.4
			set {rows, modeNames} to my listeningRows(sa, deviceName, threeLayout)
		end if
	end if
	if (count of rows) < 2 then
		my closeMenu(opener)
		return "error:no-modes"
	end if

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

-- Snapshot of the rows of the Sound menu as plain records, so the logic below is testable.
-- (Built outside any tell block: record labels must not become System Events terms.)
on describeRows(els)
	set infos to {}
	repeat with el in els
		set e to contents of el
		set end of infos to {kind:my roleOf(e), ident:my identifierOf(e), lbl:my labelOf(e), checked:my isOn(e)}
	end repeat
	return infos
end describeRows

on roleOf(el)
	tell application "System Events"
		try
			return role of el
		on error
			return ""
		end try
	end tell
end roleOf

on deviceNameOf(ident)
	if ident starts with "sound-device-" and (length of ident) > 13 then return text 14 thru -1 of ident
	return ""
end deviceNameOf

-- "modes" when the labels are listening modes, "other" when they belong to another section
-- (Spatial Audio's Off / Fixed / Head Tracked, or output devices), "unknown" otherwise (a language
-- whose labels weren't provided).
on runVerdict(infos)
	set known to 0
	set anchors to 0
	repeat with c in infos
		set l to lbl of c
		set dn to my deviceNameOf(ident of c)
		if my isOtherLabel(l) then return "other"
		if dn is not "" and l starts with dn then return "other"
		set k to my modeKey(l)
		if k is not "" then set known to known + 1
		if k is in {"Transparency", "Noise Cancellation", "Adaptive"} then set anchors to anchors + 1
	end repeat
	if known is (count of infos) and anchors > 0 then return "modes"
	if known > 0 then return "other"
	return "unknown"
end runVerdict

-- Indexes of the Listening Mode checkboxes among the rows, in on-screen order.
on pickRows(infos, deviceName)
	set n to count of infos
	-- the selected output device's row: its settings are listed below it
	set devIdx to 0
	repeat with i from 1 to n
		set el to item i of infos
		set dn to my deviceNameOf(ident of el)
		if dn is not "" and (deviceName is "" or dn is deviceName) and kind of el is "AXCheckBox" and checked of el and lbl of el starts with dn then
			set devIdx to i
			exit repeat
		end if
	end repeat
	-- the first run of 3-4 checkboxes after a heading that carries an identifier
	repeat with i from (devIdx + 1) to n
		set el to item i of infos
		if kind of el is "AXHeading" and ident of el is not "" then
			set seq to {}
			set idx to {}
			repeat with j from (i + 1) to n
				if kind of (item j of infos) is "AXCheckBox" then
					set end of seq to item j of infos
					set end of idx to j
				else
					exit repeat
				end if
			end repeat
			if (count of seq) is greater than or equal to 3 and (count of seq) is less than or equal to 4 then
				set verdict to my runVerdict(seq)
				if verdict is "modes" then return idx
				-- in other languages trust structure only below the selected device's row
				-- (only when no labels are known: with them, an unrecognised run is some other section)
				if verdict is "unknown" and devIdx > 0 and (item 2 of modeLabels) is "" then return idx
			end if
		end if
	end repeat
	-- fallback: checkboxes with mode names; "Off" only right before "Transparency"
	-- (Spatial Audio has an "Off" too)
	set found to {}
	repeat with i from 1 to n
		set el to item i of infos
		if kind of el is "AXCheckBox" then
			set k to my modeKey(lbl of el)
			if k is in {"Transparency", "Adaptive", "Noise Cancellation"} then
				set end of found to i
			else if k is "Off" and i < n then
				if my modeKey(lbl of (item (i + 1) of infos)) is "Transparency" then set end of found to i
			end if
		end if
	end repeat
	return found
end pickRows

-- The mode name of each row: from its label when known, else from the row count.
on namesFor(labels, deviceName, threeLayout)
	set mapped to {}
	repeat with l in labels
		set k to my modeKey(contents of l)
		if k is "" then exit repeat
		set end of mapped to k
	end repeat
	if (count of mapped) is (count of labels) then return mapped
	set n to count of labels
	if n is 4 then return {"Off", "Transparency", "Adaptive", "Noise Cancellation"}
	if n is 3 then
		if threeLayout is "off" or (threeLayout is "auto" and deviceName contains "Max") then return {"Off", "Transparency", "Noise Cancellation"}
		return {"Transparency", "Adaptive", "Noise Cancellation"}
	end if
	return {"Transparency", "Noise Cancellation"}
end namesFor

-- The Listening Mode checkboxes (UI elements) and their mode names.
on listeningRows(sa, deviceName, threeLayout)
	tell application "System Events" to set els to UI elements of sa
	set infos to my describeRows(els)
	set rows to {}
	set labels to {}
	repeat with i in my pickRows(infos, deviceName)
		set end of rows to item i of els
		set end of labels to lbl of (item i of infos)
	end repeat
	return {rows, my namesFor(labels, deviceName, threeLayout)}
end listeningRows

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
