# VHS tape file for recording Truman CLI demo GIF
# https://github.com/charmbracelet/vhs
#
# Prerequisites: Install VHS — https://github.com/charmbracelet/vhs
# Usage:
#   chmod +x assets/demo-sim.sh
#   vhs assets/demo.tape

Output assets/demo.gif

Set Shell "bash"
Set FontSize 16
Set Width 800
Set Height 500
Set Theme "Dracula"
Set TypingSpeed 50ms
Set Padding 20

Sleep 500ms

# User types the command
Type "npx @parentos/truman roast"
Sleep 300ms
Enter
Sleep 500ms

# Hide the real command execution — run the simulation script
# which prints output that looks like the real CLI
Hide
Type "bash assets/demo-sim.sh"
Enter
Show

# Wait for the simulation script to finish (total sleep in script is ~16s)
Sleep 20s
