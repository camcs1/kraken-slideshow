// Kraken Bridge tray app: runs kraken-bridge.js with no console window, keeps it
// running, shows its status, and holds the MQTT settings for Home Assistant.
// The MQTT password is stored with Windows DPAPI (current user only) and handed
// to the bridge in its environment.
//
// Build: powershell -File build.ps1  (uses the C# compiler that ships with Windows)
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Management;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("Kraken Bridge")]
[assembly: System.Reflection.AssemblyProduct("kraken-slideshow")]
[assembly: System.Reflection.AssemblyVersion("1.0.0.0")]

namespace KrakenTray
{
    static class Program
    {
        [STAThread]
        static void Main()
        {
            bool created;
            using (var mutex = new Mutex(true, "KrakenBridgeTray-" + Environment.UserName, out created))
            {
                if (!created) return;   // already running
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new TrayContext());
            }
        }
    }

    class Settings
    {
        public bool MqttEnabled;
        public string Host = "";
        public int Port = 1883;
        public string User = "";
        public string Password = "";   // plain text in memory only

        static string Dir { get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "KrakenBridge"); } }
        static string FilePath { get { return Path.Combine(Dir, "settings.ini"); } }
        public static bool Exists { get { return File.Exists(FilePath); } }

        public static Settings Load()
        {
            var s = new Settings();
            if (!File.Exists(FilePath)) return s;
            foreach (var line in File.ReadAllLines(FilePath))
            {
                int eq = line.IndexOf('=');
                if (eq < 1) continue;
                string k = line.Substring(0, eq).Trim(), v = line.Substring(eq + 1).Trim();
                if (k == "mqtt_enabled") s.MqttEnabled = v == "1";
                else if (k == "mqtt_host") s.Host = v;
                else if (k == "mqtt_port") int.TryParse(v, out s.Port);
                else if (k == "mqtt_user") s.User = v;
                else if (k == "mqtt_password_dpapi" && v.Length > 0)
                {
                    try { s.Password = Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(v), null, DataProtectionScope.CurrentUser)); }
                    catch { s.Password = ""; }
                }
            }
            return s;
        }

        public void Save()
        {
            Directory.CreateDirectory(Dir);
            string enc = Password.Length == 0 ? "" :
                Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(Password), null, DataProtectionScope.CurrentUser));
            File.WriteAllLines(FilePath, new[] {
                "mqtt_enabled=" + (MqttEnabled ? "1" : "0"),
                "mqtt_host=" + Host,
                "mqtt_port=" + Port,
                "mqtt_user=" + User,
                "mqtt_password_dpapi=" + enc,
            });
        }

        // Non-secret defaults from HASS.Agent, if installed (address, port, username only).
        public static Settings Defaults()
        {
            var s = new Settings { MqttEnabled = true };
            try
            {
                string p = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"HASS.Agent\Client\config\appsettings.json");
                if (File.Exists(p))
                {
                    string j = File.ReadAllText(p);
                    Match m;
                    if ((m = Regex.Match(j, "\"MqttAddress\"\\s*:\\s*\"([^\"]*)\"")).Success) s.Host = m.Groups[1].Value;
                    if ((m = Regex.Match(j, "\"MqttPort\"\\s*:\\s*(\\d+)")).Success) s.Port = int.Parse(m.Groups[1].Value);
                    if ((m = Regex.Match(j, "\"MqttUsername\"\\s*:\\s*\"([^\"]*)\"")).Success) s.User = m.Groups[1].Value;
                }
            }
            catch { }
            return s;
        }
    }

    class SettingsForm : Form
    {
        CheckBox enabled = new CheckBox { Text = "Connect to Home Assistant over MQTT", AutoSize = true };
        TextBox host = new TextBox(), port = new TextBox(), user = new TextBox();
        TextBox pass = new TextBox { UseSystemPasswordChar = true };
        public Settings Result;

        public SettingsForm(Settings s, bool hasSavedPassword)
        {
            Text = "Kraken Bridge: Home Assistant (MQTT)";
            FormBorderStyle = FormBorderStyle.FixedDialog; MaximizeBox = false; MinimizeBox = false;
            StartPosition = FormStartPosition.CenterScreen; ShowInTaskbar = true; TopMost = true;
            ClientSize = new Size(380, 230); Font = SystemFonts.MessageBoxFont;

            enabled.Checked = s.MqttEnabled; enabled.Location = new Point(14, 14);
            host.Text = s.Host; port.Text = s.Port.ToString(); user.Text = s.User;
            int y = 46;
            foreach (var row in new[] { Tuple.Create("Broker", (Control)host), Tuple.Create("Port", (Control)port),
                                        Tuple.Create("Username", (Control)user), Tuple.Create("Password", (Control)pass) })
            {
                Controls.Add(new Label { Text = row.Item1, Location = new Point(14, y + 3), AutoSize = true });
                row.Item2.Location = new Point(100, y); row.Item2.Width = 262;
                Controls.Add(row.Item2); y += 32;
            }
            var hint = new Label { ForeColor = SystemColors.GrayText, AutoSize = true, Location = new Point(100, y - 2),
                Text = hasSavedPassword ? "Leave blank to keep the saved password." : "Stored encrypted for your Windows account." };
            var ok = new Button { Text = "Save", DialogResult = DialogResult.OK, Location = new Point(206, 192), Width = 75 };
            var cancel = new Button { Text = "Cancel", DialogResult = DialogResult.Cancel, Location = new Point(287, 192), Width = 75 };
            Controls.AddRange(new Control[] { enabled, hint, ok, cancel });
            AcceptButton = ok; CancelButton = cancel;
            EventHandler toggle = delegate { host.Enabled = port.Enabled = user.Enabled = pass.Enabled = enabled.Checked; };
            enabled.CheckedChanged += toggle; toggle(null, null);

            ok.Click += delegate
            {
                int p;
                if (enabled.Checked && (host.Text.Trim().Length == 0 || !int.TryParse(port.Text, out p)))
                {
                    MessageBox.Show(this, "Enter the broker address and a port number.", Text);
                    DialogResult = DialogResult.None; return;
                }
                int.TryParse(port.Text, out p);
                Result = new Settings { MqttEnabled = enabled.Checked, Host = host.Text.Trim(), Port = p == 0 ? 1883 : p,
                                        User = user.Text.Trim(), Password = pass.Text.Length > 0 ? pass.Text : s.Password };
            };
        }
    }

    class TrayContext : ApplicationContext
    {
        readonly string bridgeDir = AppDomain.CurrentDomain.BaseDirectory;
        readonly string logPath;
        readonly NotifyIcon tray = new NotifyIcon();
        readonly ToolStripMenuItem statusItem = new ToolStripMenuItem("Starting…") { Enabled = false };
        readonly ToolStripMenuItem mqttItem = new ToolStripMenuItem("") { Enabled = false };
        readonly System.Windows.Forms.Timer poll = new System.Windows.Forms.Timer { Interval = 3000 };
        readonly object logLock = new object();
        Settings settings;
        Process bridge;
        bool quitting;
        int restartDelay = 2000;
        System.Threading.Timer restartTimer;
        string iconState = "";

        public TrayContext()
        {
            string logDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "KrakenBridge");
            Directory.CreateDirectory(logDir);
            logPath = Path.Combine(logDir, "bridge.log");

            var menu = new ContextMenuStrip();
            menu.Items.Add(statusItem);
            menu.Items.Add(mqttItem);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Next", null, delegate { Send("next"); });
            menu.Items.Add("Hold this", null, delegate { Send("hold"); });
            menu.Items.Add("Slideshow", null, delegate { Send("slideshow"); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Visualizer on", null, delegate { Send("visualizer", "on"); });
            menu.Items.Add("Next preset", null, delegate { Send("visualizer", "next"); });
            menu.Items.Add("Visualizer off", null, delegate { Send("visualizer", "off"); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Home Assistant (MQTT) settings…", null, delegate { EditSettings(); });
            menu.Items.Add("Open log", null, delegate { try { Process.Start("notepad.exe", "\"" + logPath + "\""); } catch { } });
            menu.Items.Add("Restart bridge", null, delegate { RestartBridge(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Quit", null, delegate { Quit(); });

            tray.ContextMenuStrip = menu;
            tray.Text = "Kraken Bridge";
            SetIcon("down");
            tray.Visible = true;

            bool firstRun = !Settings.Exists;
            settings = firstRun ? new Settings { MqttEnabled = false } : Settings.Load();

            // Start the bridge right away (without MQTT on first run) so the Kraken
            // keeps working even if nobody answers the settings dialog yet.
            KillStrayBridges();
            StartBridge();
            poll.Tick += delegate { RefreshStatus(); };
            poll.Start();

            if (firstRun)
            {
                var once = new System.Windows.Forms.Timer { Interval = 800 };
                once.Tick += delegate
                {
                    once.Stop(); once.Dispose();
                    // Prefilled from HASS.Agent where possible (never its password).
                    var f = new SettingsForm(Settings.Defaults(), false);
                    if (f.ShowDialog() == DialogResult.OK && f.Result != null)
                    {
                        settings = f.Result; settings.Save(); RestartBridge();
                    }
                    else settings.Save();   // remember "no MQTT"; change later from the menu
                };
                once.Start();
            }
        }

        /* ----------------------------------------------------- bridge process */
        static string FindNode()
        {
            foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';'))
            {
                try { string p = Path.Combine(dir.Trim(), "node.exe"); if (File.Exists(p)) return p; } catch { }
            }
            string pf = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"nodejs\node.exe");
            return File.Exists(pf) ? pf : "node.exe";
        }

        // A bridge started some other way (old startup script, a terminal) would hold the port.
        void KillStrayBridges()
        {
            try
            {
                using (var q = new ManagementObjectSearcher("SELECT ProcessId, CommandLine FROM Win32_Process WHERE Name='node.exe'"))
                    foreach (ManagementObject p in q.Get())
                    {
                        string cl = (p["CommandLine"] as string) ?? "";
                        if (cl.IndexOf("kraken-bridge.js", StringComparison.OrdinalIgnoreCase) >= 0 &&
                            cl.IndexOf(" send", StringComparison.OrdinalIgnoreCase) < 0)
                        {
                            try { Process.GetProcessById(Convert.ToInt32(p["ProcessId"])).Kill(); Log("stopped stray bridge pid " + p["ProcessId"]); } catch { }
                        }
                    }
            }
            catch (Exception e) { Log("could not check for stray bridges: " + e.Message); }
        }

        void StartBridge()
        {
            if (quitting) return;
            var psi = new ProcessStartInfo(FindNode(), "\"" + Path.Combine(bridgeDir, "kraken-bridge.js") + "\"")
            {
                UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = bridgeDir,
                RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true,
            };
            psi.EnvironmentVariables.Remove("KRAKEN_MQTT_HOST");
            if (settings.MqttEnabled && settings.Host.Length > 0)
            {
                psi.EnvironmentVariables["KRAKEN_MQTT_HOST"] = settings.Host;
                psi.EnvironmentVariables["KRAKEN_MQTT_PORT"] = settings.Port.ToString();
                psi.EnvironmentVariables["KRAKEN_MQTT_USER"] = settings.User;
                psi.EnvironmentVariables["KRAKEN_MQTT_PASSWORD"] = settings.Password;
            }
            try
            {
                var p = new Process { StartInfo = psi, EnableRaisingEvents = true };
                p.OutputDataReceived += (s, e) => { if (e.Data != null) Log(e.Data); };
                p.ErrorDataReceived += (s, e) => { if (e.Data != null) Log("ERR " + e.Data); };
                p.Exited += OnBridgeExited;
                p.Start();
                p.BeginOutputReadLine(); p.BeginErrorReadLine();
                bridge = p;
                Log("--- bridge started (pid " + p.Id + ", mqtt " + (settings.MqttEnabled ? settings.Host : "off") + ")");
            }
            catch (Exception e)
            {
                Log("could not start node: " + e.Message);
                ScheduleRestart();
            }
        }

        void OnBridgeExited(object sender, EventArgs e)
        {
            var p = (Process)sender;
            if (p != bridge) return;
            bridge = null;
            if (quitting) return;
            Log("bridge exited (code " + p.ExitCode + "), restarting in " + restartDelay / 1000 + "s");
            ScheduleRestart();
        }

        void ScheduleRestart()
        {
            int delay = restartDelay;
            restartDelay = Math.Min(restartDelay * 2, 60000);
            // Kept in a field: an unreferenced Threading.Timer can be collected before it fires.
            restartTimer = new System.Threading.Timer(_ => StartBridge(), null, delay, Timeout.Infinite);
        }

        void StopBridge()
        {
            var p = bridge; bridge = null;
            if (p == null) return;
            try { if (!p.HasExited) { p.Kill(); p.WaitForExit(3000); } } catch { }
        }

        void RestartBridge() { StopBridge(); restartDelay = 2000; StartBridge(); }

        void EditSettings()
        {
            var f = new SettingsForm(settings, settings.Password.Length > 0);
            if (f.ShowDialog() == DialogResult.OK && f.Result != null)
            {
                settings = f.Result; settings.Save();
                RestartBridge();
            }
        }

        void Quit()
        {
            quitting = true; poll.Stop();
            StopBridge();
            tray.Visible = false; tray.Dispose();
            ExitThread();
        }

        /* ------------------------------------------------------------ status */
        void RefreshStatus()
        {
            string page = "Bridge not running", mqtt = "", icon = "down";
            try
            {
                using (var wc = new WebClient())
                {
                    wc.Encoding = Encoding.UTF8;
                    var d = (Dictionary<string, object>)new JavaScriptSerializer().DeserializeObject(wc.DownloadString("http://127.0.0.1:27880/status"));
                    var st = d["state"] as Dictionary<string, object>;
                    int clients = Convert.ToInt32(d["clients"]);
                    if (clients == 0 || st == null) { page = "Kraken page not connected"; icon = "warn"; }
                    else
                    {
                        string mode = Convert.ToString(st["mode"]);
                        var viz = st.ContainsKey("visualizer") ? st["visualizer"] as Dictionary<string, object> : null;
                        page = mode == "visualizer" && viz != null
                            ? "Visualizer: " + viz["preset"] + " (" + viz["fps"] + " fps)"
                            : char.ToUpper(mode[0]) + mode.Substring(1) + ": " + (Convert.ToInt32(st["index"]) + 1) + " / " + st["count"];
                        icon = "ok";
                    }
                    var m = d.ContainsKey("mqtt") ? d["mqtt"] as Dictionary<string, object> : null;
                    if (m == null || !(bool)m["enabled"]) mqtt = "Home Assistant: off";
                    else if ((bool)m["connected"]) mqtt = "Home Assistant: connected (" + m["host"] + ")";
                    else { mqtt = "Home Assistant: " + (m["error"] ?? "connecting…"); if (icon == "ok") icon = "warn"; }
                }
            }
            catch { }
            statusItem.Text = page;
            mqttItem.Text = mqtt; mqttItem.Visible = mqtt.Length > 0;
            string tip = "Kraken: " + page;
            tray.Text = tip.Length > 63 ? tip.Substring(0, 62) + "…" : tip;
            SetIcon(icon);
        }

        void SetIcon(string state)
        {
            if (state == iconState) return;
            iconState = state;
            Color c = state == "ok" ? Color.FromArgb(0x3d, 0xd6, 0x8c) : state == "warn" ? Color.FromArgb(0xf2, 0xb1, 0x34) : Color.FromArgb(0x8a, 0x8a, 0x8a);
            using (var bmp = new Bitmap(32, 32))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    using (var ring = new Pen(c, 4)) g.DrawEllipse(ring, 3, 3, 26, 26);   // the round LCD
                    using (var dot = new SolidBrush(c)) g.FillEllipse(dot, 11, 11, 10, 10);
                }
                var old = tray.Icon;
                tray.Icon = Icon.FromHandle(bmp.GetHicon());
                if (old != null) old.Dispose();
            }
        }

        /* ---------------------------------------------------------- commands */
        void Send(string action, string mode = null)
        {
            ThreadPool.QueueUserWorkItem(_ =>
            {
                try
                {
                    using (var wc = new WebClient())
                    {
                        wc.Headers[HttpRequestHeader.ContentType] = "application/json";
                        wc.UploadString("http://127.0.0.1:27880/command", "{\"action\":\"" + action + "\"" + (mode != null ? ",\"mode\":\"" + mode + "\"" : "") + "}");
                    }
                }
                catch (WebException e) { Log("menu command " + action + " failed: " + e.Message); }
            });
        }

        void Log(string line)
        {
            lock (logLock)
            {
                try
                {
                    var fi = new FileInfo(logPath);
                    if (fi.Exists && fi.Length > 1024 * 1024) File.Copy(logPath, logPath + ".1", true);
                    if (fi.Exists && fi.Length > 1024 * 1024) File.WriteAllText(logPath, "");
                    File.AppendAllText(logPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss ") + line + Environment.NewLine);
                }
                catch { }
            }
        }
    }
}
