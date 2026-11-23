@echo off
rem Wrapper for HASS.Agent action commands. HASS.Agent quotes the whole
rem configured command before appending the payload, so the command has to be
rem a single path: "...\kraken.cmd" next  ->  node kraken-bridge.js send next
node "%~dp0kraken-bridge.js" send %*
