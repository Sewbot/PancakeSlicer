using System;
using System.Runtime.InteropServices;

static class SpaceMouseRaw
{
    const uint WM_INPUT = 0x00FF;
    const uint RID_INPUT = 0x10000003;
    const uint RIM_TYPEHID = 2;
    const uint RIDEV_INPUTSINK = 0x00000100;
    const int WM_DESTROY = 0x0002;

    [StructLayout(LayoutKind.Sequential)]
    struct RAWINPUTDEVICE
    {
        public ushort usUsagePage;
        public ushort usUsage;
        public uint dwFlags;
        public IntPtr hwndTarget;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct RAWINPUTHEADER
    {
        public uint dwType;
        public uint dwSize;
        public IntPtr hDevice;
        public IntPtr wParam;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct WNDCLASS
    {
        public uint style;
        public IntPtr lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        public string lpszMenuName;
        public string lpszClassName;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct POINT
    {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
        public uint lPrivate;
    }

    delegate IntPtr WndProc(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    static readonly WndProc Proc = OnMessage;
    static readonly int HeaderSize = Marshal.SizeOf(typeof(RAWINPUTHEADER));

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern ushort RegisterClassW(ref WNDCLASS lpWndClass);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateWindowExW(uint dwExStyle, string lpClassName, string lpWindowName, uint dwStyle,
        int x, int y, int width, int height, IntPtr hWndParent, IntPtr hMenu, IntPtr hInstance, IntPtr lpParam);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool RegisterRawInputDevices([In] RAWINPUTDEVICE[] devices, uint count, uint size);

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint GetRawInputData(IntPtr hRawInput, uint command, IntPtr data, ref uint size, uint headerSize);

    [DllImport("user32.dll")]
    static extern IntPtr DefWindowProcW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    static extern int GetMessageW(out MSG msg, IntPtr hWnd, uint min, uint max);

    [DllImport("user32.dll")]
    static extern bool TranslateMessage(ref MSG msg);

    [DllImport("user32.dll")]
    static extern IntPtr DispatchMessageW(ref MSG msg);

    [DllImport("user32.dll")]
    static extern void PostQuitMessage(int code);

    [STAThread]
    static int Main()
    {
        var cls = new WNDCLASS
        {
            lpfnWndProc = Marshal.GetFunctionPointerForDelegate(Proc),
            lpszClassName = "PancakeSpaceMouse",
        };
        if (RegisterClassW(ref cls) == 0)
        {
            Console.WriteLine("ERROR register-class");
            return 1;
        }
        var hwnd = CreateWindowExW(0x80, "PancakeSpaceMouse", "PancakeSpaceMouse", 0x80000000, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (hwnd == IntPtr.Zero)
        {
            Console.WriteLine("ERROR create-window");
            return 1;
        }
        var devices = new[]
        {
            new RAWINPUTDEVICE
            {
                usUsagePage = 0x01,
                usUsage = 0x08,
                dwFlags = RIDEV_INPUTSINK,
                hwndTarget = hwnd,
            },
        };
        if (!RegisterRawInputDevices(devices, 1, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE))))
        {
            Console.WriteLine("ERROR register-device");
            return 1;
        }
        Console.WriteLine("READY");
        Console.Out.Flush();
        MSG msg;
        while (GetMessageW(out msg, IntPtr.Zero, 0, 0) > 0)
        {
            TranslateMessage(ref msg);
            DispatchMessageW(ref msg);
        }
        return 0;
    }

    static IntPtr OnMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        if (msg == WM_DESTROY)
        {
            PostQuitMessage(0);
            return IntPtr.Zero;
        }
        if (msg == WM_INPUT) ReadReport(lParam);
        return DefWindowProcW(hWnd, msg, wParam, lParam);
    }

    static void ReadReport(IntPtr hRaw)
    {
        uint size = 0;
        GetRawInputData(hRaw, RID_INPUT, IntPtr.Zero, ref size, (uint)HeaderSize);
        if (size < (uint)HeaderSize || size > 4096) return;
        var buffer = Marshal.AllocHGlobal((int)size);
        try
        {
            uint filled = size;
            var got = GetRawInputData(hRaw, RID_INPUT, buffer, ref filled, (uint)HeaderSize);
            if (got == 0 || got == 0xFFFFFFFF) return;
            if ((uint)Marshal.ReadInt32(buffer, 0) != RIM_TYPEHID) return;
            var reportSize = Marshal.ReadInt32(buffer, HeaderSize);
            var count = Marshal.ReadInt32(buffer, HeaderSize + 4);
            if (reportSize <= 0 || reportSize > 64 || count <= 0 || count > 8) return;
            var data = HeaderSize + 8;
            for (var i = 0; i < count; i++)
            {
                var bytes = new byte[reportSize];
                Marshal.Copy(new IntPtr(buffer.ToInt64() + data + (i * reportSize)), bytes, 0, reportSize);
                Console.WriteLine(BitConverter.ToString(bytes).Replace("-", ""));
                Console.Out.Flush();
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }
}
