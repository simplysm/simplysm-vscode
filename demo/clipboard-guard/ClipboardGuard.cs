// 시연 하네스의 클립보드 보존 도구 — 시연 전 클립보드의 모든 형식을 꺼내 두었다가, 시연이 클립보드를 바꾸면 다시 넣는다.
// clipboard-guard.ts 가 Windows 에 든 .NET Framework 의 csc 로 컴파일해 쓴다. 언어 수준은 그 csc 가 아는 C# 5 다.
//
// 명령 — 꺼낸 내용은 표준 입출력으로만 주고받는다. 사용자가 복사해 둔 비밀번호 등이 디스크에 남지 않게 파일에 쓰지 않는다.
// - seq     : 클립보드 순번(GetClipboardSequenceNumber)을 stdout 에 쓴다. OS 는 클립보드 내용이 바뀔 때마다 순번을 올린다.
// - owner <pid> : 지금 클립보드를 누가 넣었는지를 JSON 한 줄로 쓴다. 소유 창(GetClipboardOwner)의 프로세스가 <pid> 이거나
//   그 자손이면 fromDemo 가 참이다. 소유 창이 없으면(넣은 프로그램이 끝났거나 소유 창 없이 넣음) 거짓이다.
//   {"seq": 순번, "ownerPid": 소유 프로세스(없으면 0), "owner": 실행 파일 이름, "fromDemo": 참/거짓}
// - save    : 클립보드의 모든 형식을 꺼내 묶음(아래 "묶음")으로 stdout 에 쓴다.
// - restore : stdin 의 묶음을 클립보드에 다시 넣고, 넣은 뒤 다시 읽어 같은지 확인한 결과를 JSON 한 줄로 stdout 에 쓴다.
//   {"seq": 넣은 뒤 순번, "formats": 묶음의 형식 수, "notRestored": [{"format": 이름, "reason": 이유}]}
// 클립보드를 열지 못하는 등 명령 자체가 실패하면 0 이 아닌 종료 코드로 끝나고 stderr 에 이유를 쓴다.
// 글자는 모두 UTF-8 로 쓴다 — 콘솔 코드 페이지(한국어 Windows 는 949)를 따르지 않게.
//
// 형식별 처리 — 원래 형식을 열거 순서 그대로 모두 실제 데이터로 다시 넣는다. OS 가 다른 형식에서 만들어 주던
// 형식(합성 형식: CF_UNICODETEXT → CF_TEXT · CF_OEMTEXT · CF_LOCALE, CF_DIB ↔ CF_BITMAP · CF_DIBV5 등)도 같은 내용을
// 실제 데이터로 넣는다. 읽는 쪽에는 내용 · 형식 목록 · 열거 순서가 같아 보인다.
// - HGLOBAL 형식(텍스트 · CF_DIB · CF_HDROP · 등록 형식 등 대부분): 메모리 바이트를 그대로.
//   CF_PRIVATEFIRST~LAST(0x0200~0x02FF)도 여기에 든다 — 문서는 "핸들의 뜻은 소유 프로그램이 정한다"지만, OS 가
//   그 데이터를 HGLOBAL 로 복사해 다른 프로세스에 넘긴다(실측: 소유자가 넣은 4바이트 HGLOBAL 을 다른 프로세스에서
//   GlobalSize 4 로 읽고, 되돌린 뒤 같은 바이트).
//   OLE 클립보드의 내부 형식 "DataObject"(원본 프로그램의 OLE 창 핸들) · "Ole Private Data"(형식별 저장 매체)도
//   바이트 그대로 되돌린다. 실측: 원본 프로그램이 살아 있을 때도 끝난 뒤에도, 되돌린 파일 목록을 OLE 로 읽는
//   프로그램(WinForms Clipboard.GetFileDropList)이 파일 목록 · Preferred DropEffect 를 그대로 읽는다.
// - CF_BITMAP · CF_DSPBITMAP: 32bpp DIB 로 꺼내 화면 호환 비트맵(DDB)으로 다시 만든다.
// - CF_ENHMETAFILE · CF_DSPENHMETAFILE, CF_METAFILEPICT · CF_DSPMETAFILEPICT: 메타파일 비트로.
// - CF_PALETTE: 색 항목으로.
//
// 되돌리지 못하는 형식 — 묶음에 이유와 함께 남기고, restore 의 notRestored 에 적는다 (2026-10-19 Windows 11 실측).
// - 지연 렌더링(SetClipboardData(형식, NULL)) 형식: 꺼낼 때 소유 창에 WM_RENDERFORMAT 을 보내 그때 데이터를
//   받는다. 소유 창이 데이터를 넣으면 되돌릴 수 있다. 넣지 않으면 GetClipboardData 가 NULL 이라 되돌리지 못한다.
//   소유 창이 메시지에 답하지 않으면(멈춘 프로그램) GetClipboardData 가 돌아오지 않는다 — save 는 SaveBudgetMs
//   안에 읽은 형식만 묶고, 멈춘 형식과 그 뒤 형식을 되돌리지 못한 것으로 적는다.
//   실측: 메시지 처리를 멈춘 지 2초 된 소유 창의 형식은 15초가 지나도 GetClipboardData 가 돌아오지 않았다.
//   멈춘 지 18초쑤 된 뒤(OS 가 그 창을 "응답 없음"으로 본 뒤)에는 약 2초 만에 NULL 이 돌아왔다.
//   탐색기의 파일 복사처럼 OLE 클립보드(OleSetClipboard)로 넣고 데이터 객체를 살려 둔 내용도 이 경우다.
//   실측: 셸 데이터 객체의 "FileContents"(파일마다 IStream 으로만 주는 형식)는 목록에만 보이고
//   GetClipboardData 가 NULL 이다. 나머지(Shell IDList Array · CF_HDROP · FileGroupDescriptorW · Preferred
//   DropEffect 등)는 되돌린다. 되돌린 뒤에는 원본 프로그램의 데이터 객체가 아니라 그 내용의 복사본이다.
// - CF_OWNERDISPLAY: 소유 창이 직접 그리는 형식이라 데이터가 없다(실측: GetClipboardData 가 NULL).
// - CF_GDIOBJFIRST~LAST(0x0300~0x03FF): OS 가 핸들 값만 넘긴다. 실측: 소유자가 넣은 브러시 핸들이 다른
//   프로세스에서는 GDI 객체도(GetObjectType 0) HGLOBAL 도(GlobalSize 오류 6) 아니다.
//
// 묶음(리틀 엔디언): "SDCB" · int32 버전(1) · uint32 순번 · int32 형식 수 · 형식마다
// [uint32 형식 번호 · string 이름 · int32 종류(EntryKind) · string 못 읽은 이유 · int32 길이 · 바이트].
// string 은 BinaryWriter.Write(string) 꼴이다. clipboard-guard.ts 는 순번(오프셋 8)만 읽는다.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static class Native
{
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool OpenClipboard(IntPtr newOwner);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseClipboard();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EmptyClipboard();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint EnumClipboardFormats(uint format);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr GetClipboardData(uint format);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SetClipboardData(uint format, IntPtr data);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern int GetClipboardFormatName(uint format, StringBuilder name, int maxCount);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern uint RegisterClipboardFormat(string name);

    [DllImport("user32.dll")]
    public static extern uint GetClipboardSequenceNumber();

    [DllImport("user32.dll")]
    public static extern IntPtr GetClipboardOwner();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "Process32FirstW")]
    public static extern bool Process32First(IntPtr snapshot, ref ProcessEntry32 entry);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "Process32NextW")]
    public static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry32 entry);

    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr handle);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateWindowEx(
        uint exStyle, string className, string windowName, uint style,
        int x, int y, int width, int height,
        IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);

    [DllImport("user32.dll")]
    public static extern IntPtr GetDC(IntPtr window);

    [DllImport("user32.dll")]
    public static extern int ReleaseDC(IntPtr window, IntPtr dc);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GlobalLock(IntPtr memory);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GlobalUnlock(IntPtr memory);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern UIntPtr GlobalSize(IntPtr memory);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GlobalFree(IntPtr memory);

    [DllImport("gdi32.dll", SetLastError = true)]
    public static extern int GetObject(IntPtr gdiObject, int size, byte[] buffer);

    [DllImport("gdi32.dll", SetLastError = true)]
    public static extern int GetDIBits(
        IntPtr dc, IntPtr bitmap, uint startLine, uint lineCount, byte[] bits, byte[] info, uint usage);

    [DllImport("gdi32.dll", SetLastError = true)]
    public static extern IntPtr CreateDIBitmap(
        IntPtr dc, byte[] header, uint init, byte[] bits, byte[] info, uint usage);

    [DllImport("gdi32.dll", SetLastError = true)]
    public static extern uint GetEnhMetaFileBits(IntPtr metafile, uint size, byte[] buffer);

    [DllImport("gdi32.dll", SetLastError = true)]
    public static extern IntPtr SetEnhMetaFileBits(uint size, byte[] buffer);

    [DllImport("gdi32.dll", SetLastError = true)]
    public static extern uint GetMetaFileBitsEx(IntPtr metafile, uint size, byte[] buffer);

    [DllImport("gdi32.dll", SetLastError = true)]
    public static extern IntPtr SetMetaFileBitsEx(uint size, byte[] buffer);

    [DllImport("gdi32.dll", SetLastError = true)]
    public static extern uint GetPaletteEntries(IntPtr palette, uint start, uint count, byte[] entries);

    [DllImport("gdi32.dll", SetLastError = true)]
    public static extern IntPtr CreatePalette(byte[] logPalette);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteObject(IntPtr gdiObject);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteEnhMetaFile(IntPtr metafile);

    [DllImport("gdi32.dll")]
    public static extern bool DeleteMetaFile(IntPtr metafile);
}

/// <summary>Toolhelp 프로세스 항목(PROCESSENTRY32W).</summary>
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
internal struct ProcessEntry32
{
    public uint dwSize;
    public uint cntUsage;
    public uint th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID;
    public uint cntThreads;
    public uint th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
    public string szExeFile;
}

/// <summary>형식 하나를 어떤 꼴로 꺼내 두었는가.</summary>
internal enum EntryKind
{
    Unreadable = 0,
    Global = 1,
    Bitmap = 2,
    EnhMetaFile = 3,
    MetaFilePict = 4,
    Palette = 5,
}

/// <summary>꺼내 둔 형식 하나.</summary>
internal sealed class Entry
{
    public uint Id;
    public string Name = "";
    public EntryKind Kind;
    /// <summary>Kind 가 Unreadable 일 때 그 이유.</summary>
    public string Reason = "";
    public byte[] Data = new byte[0];
}

/// <summary>save 의 읽기 스레드가 채우는 진행 상황 — 제한 시간이 지나면 주 스레드가 여기까지를 묶는다.</summary>
internal sealed class SaveProgress
{
    public List<uint> Formats;
    public readonly List<Entry> Entries = new List<Entry>();
    public Exception Error;
}

internal static class Program
{
    /// <summary>
    /// save 의 제한 시간. 지연 렌더링 형식의 소유 창이 답하지 않으면 GetClipboardData 가 돌아오지 않는다 —
    /// 그때까지 읽은 형식을 묶어 내고 프로세스를 끝내 열린 클립보드를 푼다.
    /// clipboard-guard.ts 의 save 제한 시간보다 짧아야 한다.
    /// </summary>
    private const int SaveBudgetMs = 15000;

    private const uint GMEM_MOVEABLE = 0x0002;
    private const uint CBM_INIT = 4;
    private const uint DIB_RGB_COLORS = 0;
    private static readonly IntPtr HWND_MESSAGE = new IntPtr(-3);

    private static int Main(string[] args)
    {
        try
        {
            string command = args.Length >= 1 ? args[0] : "";
            uint rootProcessId;
            switch (command)
            {
                case "seq":
                    WriteText(Console.OpenStandardOutput(), Native.GetClipboardSequenceNumber().ToString());
                    return 0;
                case "owner":
                    if (args.Length != 2 || !uint.TryParse(args[1], out rootProcessId)) goto default;
                    return Owner(rootProcessId);
                case "save":
                    return Save();
                case "restore":
                    return Restore();
                default:
                    WriteText(Console.OpenStandardError(), "usage: ClipboardGuard seq|owner <pid>|save|restore\n");
                    return 64;
            }
        }
        catch (Exception error)
        {
            WriteText(Console.OpenStandardError(), error.Message + "\n");
            return 1;
        }
    }

    private static void WriteText(Stream stream, string text)
    {
        byte[] bytes = new UTF8Encoding(false).GetBytes(text);
        stream.Write(bytes, 0, bytes.Length);
        stream.Flush();
    }

    // ---- owner ----

    private static int Owner(uint rootProcessId)
    {
        // 순번을 소유자를 읽기 전과 뒤에 읽어, 그사이 클립보드가 바뀌면 다시 읽는다 — 순번과 소유자가 같은 때의 것이게.
        for (int attempt = 0; ; attempt++)
        {
            uint sequence = Native.GetClipboardSequenceNumber();
            IntPtr window = Native.GetClipboardOwner();
            uint ownerProcessId = 0;
            if (window != IntPtr.Zero) Native.GetWindowThreadProcessId(window, out ownerProcessId);
            Dictionary<uint, ProcessEntry32> processes = SnapshotProcesses();
            if (Native.GetClipboardSequenceNumber() != sequence && attempt < 5) continue;

            ProcessEntry32 owner;
            string ownerName = ownerProcessId != 0 && processes.TryGetValue(ownerProcessId, out owner) ? owner.szExeFile : "";
            bool fromDemo = ownerProcessId != 0 && IsSelfOrDescendant(ownerProcessId, rootProcessId, processes);
            var json = new StringBuilder();
            json.Append("{\"seq\":").Append(sequence);
            json.Append(",\"ownerPid\":").Append(ownerProcessId);
            json.Append(",\"owner\":").Append(JsonString(ownerName));
            json.Append(",\"fromDemo\":").Append(fromDemo ? "true" : "false").Append('}');
            WriteText(Console.OpenStandardOutput(), json.ToString());
            return 0;
        }
    }

    /// <summary>지금 프로세스들 — 프로세스 번호로 찾는다.</summary>
    private static Dictionary<uint, ProcessEntry32> SnapshotProcesses()
    {
        const uint TH32CS_SNAPPROCESS = 0x00000002;
        var processes = new Dictionary<uint, ProcessEntry32>();
        IntPtr snapshot = Native.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateToolhelp32Snapshot failed");
        try
        {
            var entry = new ProcessEntry32();
            entry.dwSize = (uint)Marshal.SizeOf(typeof(ProcessEntry32));
            for (bool more = Native.Process32First(snapshot, ref entry); more; more = Native.Process32Next(snapshot, ref entry))
            {
                processes[entry.th32ProcessID] = entry;
            }
        }
        finally
        {
            Native.CloseHandle(snapshot);
        }
        return processes;
    }

    /// <summary>
    /// processId 가 rootProcessId 이거나 그 자손이면 참. 부모를 따라 올라간다 — 중간 부모가 이미 끝나
    /// 목록에 없으면 거기서 멈춘다(거짓).
    /// </summary>
    private static bool IsSelfOrDescendant(uint processId, uint rootProcessId, Dictionary<uint, ProcessEntry32> processes)
    {
        uint current = processId;
        for (int depth = 0; depth < 64; depth++)
        {
            if (current == rootProcessId) return true;
            ProcessEntry32 entry;
            if (current == 0 || !processes.TryGetValue(current, out entry)) return false;
            if (entry.th32ParentProcessID == current) return false;
            current = entry.th32ParentProcessID;
        }
        return false;
    }

    // ---- save ----

    private static int Save()
    {
        var progress = new SaveProgress();
        var reader = new Thread(() => ReadAll(progress));
        reader.IsBackground = true;
        reader.Start();
        bool finished = reader.Join(SaveBudgetMs);

        var entries = new List<Entry>();
        lock (progress)
        {
            if (progress.Error != null) throw progress.Error;
            if (progress.Formats == null) throw new TimeoutException("could not enumerate clipboard formats in time");
            entries.AddRange(progress.Entries);
            for (int index = entries.Count; index < progress.Formats.Count; index++)
            {
                uint id = progress.Formats[index];
                entries.Add(Unreadable(id, index == progress.Entries.Count
                    ? "the clipboard owner did not render it within " + SaveBudgetMs + " ms"
                    : "not read: the clipboard owner did not render an earlier format in time"));
            }
        }

        using (var stdout = Console.OpenStandardOutput())
        {
            byte[] bundle = WriteBundle(Native.GetClipboardSequenceNumber(), entries);
            stdout.Write(bundle, 0, bundle.Length);
            stdout.Flush();
        }
        // 멈춘 읽기 스레드가 클립보드를 열어 둔 채다 — 프로세스를 끝내야 OS 가 클립보드를 닫는다.
        if (!finished) Environment.Exit(0);
        return 0;
    }

    private static void ReadAll(SaveProgress progress)
    {
        try
        {
            OpenClipboardWithRetry(IntPtr.Zero);
            try
            {
                List<uint> formats = EnumerateFormats();
                lock (progress) progress.Formats = formats;
                foreach (uint id in formats)
                {
                    Entry entry = ReadEntry(id);
                    lock (progress) progress.Entries.Add(entry);
                }
            }
            finally
            {
                Native.CloseClipboard();
            }
        }
        catch (Exception error)
        {
            lock (progress) progress.Error = error;
        }
    }

    /// <summary>열린 클립보드의 형식 번호 — 열거 순서(넣은 순서, 합성 형식은 뒤).</summary>
    private static List<uint> EnumerateFormats()
    {
        var formats = new List<uint>();
        for (uint id = Native.EnumClipboardFormats(0); id != 0; id = Native.EnumClipboardFormats(id))
        {
            formats.Add(id);
        }
        int error = Marshal.GetLastWin32Error();
        if (error != 0) throw new Win32Exception(error, "EnumClipboardFormats failed");
        return formats;
    }

    private static Entry Unreadable(uint id, string reason)
    {
        var entry = new Entry();
        entry.Id = id;
        entry.Name = FormatName(id);
        entry.Kind = EntryKind.Unreadable;
        entry.Reason = reason;
        return entry;
    }

    /// <summary>열린 클립보드에서 형식 하나를 꺼낸다. 꺼내지 못하면 이유를 담은 Unreadable 로.</summary>
    private static Entry ReadEntry(uint id)
    {
        string unsupported = UnsupportedReason(id);
        if (unsupported != null) return Unreadable(id, unsupported);
        IntPtr handle = Native.GetClipboardData(id);
        if (handle == IntPtr.Zero)
        {
            return Unreadable(id, "no data (the clipboard owner did not render it), win32 error " +
                Marshal.GetLastWin32Error());
        }
        var entry = new Entry();
        entry.Id = id;
        entry.Name = FormatName(id);
        entry.Kind = KindOf(id);
        try
        {
            switch (entry.Kind)
            {
                case EntryKind.Bitmap: entry.Data = ReadBitmap(handle); break;
                case EntryKind.EnhMetaFile: entry.Data = ReadEnhMetaFile(handle); break;
                case EntryKind.MetaFilePict: entry.Data = ReadMetaFilePict(handle); break;
                case EntryKind.Palette: entry.Data = ReadPalette(handle); break;
                default: entry.Data = ReadGlobal(handle); break;
            }
        }
        catch (Exception error)
        {
            return Unreadable(id, error.Message);
        }
        return entry;
    }

    /// <summary>항상 되돌리지 못하는 형식이면 그 이유, 아니면 null.</summary>
    private static string UnsupportedReason(uint id)
    {
        if (id == 0x0080) return "owner-display format: the owner draws it, there is no data";
        if (id >= 0x0300 && id <= 0x03FF) return "GDI object format: the handle belongs to the owner process";
        return null;
    }

    private static EntryKind KindOf(uint id)
    {
        switch (id)
        {
            case 2: case 0x0082: return EntryKind.Bitmap; // CF_BITMAP, CF_DSPBITMAP
            case 3: case 0x0083: return EntryKind.MetaFilePict; // CF_METAFILEPICT, CF_DSPMETAFILEPICT
            case 9: return EntryKind.Palette; // CF_PALETTE
            case 14: case 0x008E: return EntryKind.EnhMetaFile; // CF_ENHMETAFILE, CF_DSPENHMETAFILE
            default: return EntryKind.Global;
        }
    }

    private static string FormatName(uint id)
    {
        switch (id)
        {
            case 1: return "CF_TEXT";
            case 2: return "CF_BITMAP";
            case 3: return "CF_METAFILEPICT";
            case 4: return "CF_SYLK";
            case 5: return "CF_DIF";
            case 6: return "CF_TIFF";
            case 7: return "CF_OEMTEXT";
            case 8: return "CF_DIB";
            case 9: return "CF_PALETTE";
            case 10: return "CF_PENDATA";
            case 11: return "CF_RIFF";
            case 12: return "CF_WAVE";
            case 13: return "CF_UNICODETEXT";
            case 14: return "CF_ENHMETAFILE";
            case 15: return "CF_HDROP";
            case 16: return "CF_LOCALE";
            case 17: return "CF_DIBV5";
            case 0x0080: return "CF_OWNERDISPLAY";
            case 0x0081: return "CF_DSPTEXT";
            case 0x0082: return "CF_DSPBITMAP";
            case 0x0083: return "CF_DSPMETAFILEPICT";
            case 0x008E: return "CF_DSPENHMETAFILE";
        }
        if (id >= 0x0200 && id <= 0x02FF) return "CF_PRIVATEFIRST+" + (id - 0x0200);
        if (id >= 0x0300 && id <= 0x03FF) return "CF_GDIOBJFIRST+" + (id - 0x0300);
        if (id >= 0xC000)
        {
            var name = new StringBuilder(256);
            if (Native.GetClipboardFormatName(id, name, name.Capacity) > 0) return name.ToString();
        }
        return "0x" + id.ToString("X4");
    }

    private static byte[] ReadGlobal(IntPtr handle)
    {
        int size = checked((int)Native.GlobalSize(handle).ToUInt64());
        var data = new byte[size];
        if (size == 0) return data;
        IntPtr pointer = Native.GlobalLock(handle);
        if (pointer == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "GlobalLock failed");
        try
        {
            Marshal.Copy(pointer, data, 0, size);
        }
        finally
        {
            Native.GlobalUnlock(handle);
        }
        return data;
    }

    /// <summary>비트맵을 BITMAPINFOHEADER(32bpp, BI_RGB) + 픽셀 바이트로.</summary>
    private static byte[] ReadBitmap(IntPtr bitmap)
    {
        // BITMAP { LONG bmType; LONG bmWidth; LONG bmHeight; LONG bmWidthBytes; WORD bmPlanes; WORD bmBitsPixel; LPVOID bmBits; }
        var bitmapInfo = new byte[IntPtr.Size == 8 ? 32 : 24];
        if (Native.GetObject(bitmap, bitmapInfo.Length, bitmapInfo) == 0) throw new Win32Exception("GetObject(HBITMAP) failed");
        int width = BitConverter.ToInt32(bitmapInfo, 4);
        int height = BitConverter.ToInt32(bitmapInfo, 8);
        var info = new byte[40 + 256 * 4];
        WriteBitmapInfoHeader(info, width, height);
        var bits = new byte[checked(width * height * 4)];
        IntPtr dc = Native.GetDC(IntPtr.Zero);
        try
        {
            if (Native.GetDIBits(dc, bitmap, 0, (uint)height, bits, info, DIB_RGB_COLORS) != height)
            {
                throw new Win32Exception("GetDIBits failed");
            }
        }
        finally
        {
            Native.ReleaseDC(IntPtr.Zero, dc);
        }
        var data = new byte[40 + bits.Length];
        WriteBitmapInfoHeader(data, width, height);
        Buffer.BlockCopy(bits, 0, data, 40, bits.Length);
        return data;
    }

    private static void WriteBitmapInfoHeader(byte[] buffer, int width, int height)
    {
        Array.Clear(buffer, 0, 40);
        WriteInt32(buffer, 0, 40); // biSize
        WriteInt32(buffer, 4, width);
        WriteInt32(buffer, 8, height); // 양수 = 아래에서 위로
        buffer[12] = 1; // biPlanes
        buffer[14] = 32; // biBitCount
        // biCompression = BI_RGB(0), 나머지 0
    }

    private static void WriteInt32(byte[] buffer, int offset, int value)
    {
        byte[] bytes = BitConverter.GetBytes(value);
        Buffer.BlockCopy(bytes, 0, buffer, offset, 4);
    }

    private static byte[] ReadEnhMetaFile(IntPtr metafile)
    {
        uint size = Native.GetEnhMetaFileBits(metafile, 0, null);
        if (size == 0) throw new Win32Exception("GetEnhMetaFileBits failed");
        var data = new byte[size];
        if (Native.GetEnhMetaFileBits(metafile, size, data) != size) throw new Win32Exception("GetEnhMetaFileBits failed");
        return data;
    }

    /// <summary>METAFILEPICT 를 int32 mm · xExt · yExt + 메타파일 비트로.</summary>
    private static byte[] ReadMetaFilePict(IntPtr handle)
    {
        IntPtr pointer = Native.GlobalLock(handle);
        if (pointer == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "GlobalLock failed");
        try
        {
            // METAFILEPICT { LONG mm; LONG xExt; LONG yExt; HMETAFILE hMF; } — hMF 는 포인터 크기로 정렬된다.
            var header = new byte[12];
            Marshal.Copy(pointer, header, 0, 12);
            IntPtr metafile = Marshal.ReadIntPtr(pointer, IntPtr.Size == 8 ? 16 : 12);
            uint size = Native.GetMetaFileBitsEx(metafile, 0, null);
            if (size == 0) throw new Win32Exception("GetMetaFileBitsEx failed");
            var data = new byte[12 + size];
            Buffer.BlockCopy(header, 0, data, 0, 12);
            var bits = new byte[size];
            if (Native.GetMetaFileBitsEx(metafile, size, bits) != size) throw new Win32Exception("GetMetaFileBitsEx failed");
            Buffer.BlockCopy(bits, 0, data, 12, bits.Length);
            return data;
        }
        finally
        {
            Native.GlobalUnlock(handle);
        }
    }

    /// <summary>팔레트를 WORD 항목 수 + PALETTEENTRY 들로.</summary>
    private static byte[] ReadPalette(IntPtr palette)
    {
        var countBuffer = new byte[2];
        if (Native.GetObject(palette, 2, countBuffer) == 0) throw new Win32Exception("GetObject(HPALETTE) failed");
        ushort count = BitConverter.ToUInt16(countBuffer, 0);
        var data = new byte[2 + count * 4];
        Buffer.BlockCopy(countBuffer, 0, data, 0, 2);
        var entries = new byte[count * 4];
        if (count > 0 && Native.GetPaletteEntries(palette, 0, count, entries) != count)
        {
            throw new Win32Exception("GetPaletteEntries failed");
        }
        Buffer.BlockCopy(entries, 0, data, 2, entries.Length);
        return data;
    }

    private static byte[] WriteBundle(uint sequence, List<Entry> entries)
    {
        using (var memory = new MemoryStream())
        {
            using (var writer = new BinaryWriter(memory, Encoding.UTF8))
            {
                writer.Write(Encoding.ASCII.GetBytes("SDCB"));
                writer.Write(1);
                writer.Write(sequence);
                writer.Write(entries.Count);
                foreach (Entry entry in entries)
                {
                    writer.Write(entry.Id);
                    writer.Write(entry.Name);
                    writer.Write((int)entry.Kind);
                    writer.Write(entry.Reason);
                    writer.Write(entry.Data.Length);
                    writer.Write(entry.Data);
                }
            }
            return memory.ToArray();
        }
    }

    private static List<Entry> ReadBundle(byte[] bundle)
    {
        using (var reader = new BinaryReader(new MemoryStream(bundle), Encoding.UTF8))
        {
            if (Encoding.ASCII.GetString(reader.ReadBytes(4)) != "SDCB" || reader.ReadInt32() != 1)
            {
                throw new InvalidDataException("not a clipboard bundle");
            }
            reader.ReadUInt32(); // 순번
            int count = reader.ReadInt32();
            var entries = new List<Entry>(count);
            for (int index = 0; index < count; index++)
            {
                var entry = new Entry();
                entry.Id = reader.ReadUInt32();
                entry.Name = reader.ReadString();
                entry.Kind = (EntryKind)reader.ReadInt32();
                entry.Reason = reader.ReadString();
                entry.Data = reader.ReadBytes(reader.ReadInt32());
                entries.Add(entry);
            }
            return entries;
        }
    }

    // ---- restore ----

    private static int Restore()
    {
        List<Entry> saved;
        using (var stdin = Console.OpenStandardInput())
        using (var memory = new MemoryStream())
        {
            stdin.CopyTo(memory);
            saved = ReadBundle(memory.ToArray());
        }

        // OpenClipboard(NULL) 뒤 EmptyClipboard 는 소유 창을 비워 SetClipboardData 가 실패할 수 있다(문서) —
        // 메시지 전용 창을 소유 창으로 쓴다. 지연 렌더링을 쓰지 않아 이 프로세스가 끝나도 넣은 데이터는 남는다.
        IntPtr owner = Native.CreateWindowEx(0, "STATIC", "", 0, 0, 0, 0, 0, HWND_MESSAGE, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        if (owner == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateWindowEx failed");

        var failures = new Dictionary<uint, string>();
        OpenClipboardWithRetry(owner);
        try
        {
            if (!Native.EmptyClipboard()) throw new Win32Exception(Marshal.GetLastWin32Error(), "EmptyClipboard failed");
            foreach (Entry entry in saved)
            {
                if (entry.Kind == EntryKind.Unreadable)
                {
                    failures[entry.Id] = entry.Reason;
                    continue;
                }
                IntPtr handle;
                try
                {
                    handle = CreateHandle(entry);
                }
                catch (Exception error)
                {
                    failures[entry.Id] = "could not rebuild the data: " + error.Message;
                    continue;
                }
                uint id = entry.Id >= 0xC000 ? Native.RegisterClipboardFormat(entry.Name) : entry.Id;
                if (id == 0 || Native.SetClipboardData(id, handle) == IntPtr.Zero)
                {
                    int error = Marshal.GetLastWin32Error();
                    FreeHandle(entry.Kind, handle);
                    failures[entry.Id] = "SetClipboardData failed, win32 error " + error;
                }
            }
        }
        finally
        {
            Native.CloseClipboard();
        }

        // 넣은 뒤 다시 읽어 꺼낸 때와 같은지 본다.
        Dictionary<string, Entry> current = ReadCurrent();
        foreach (Entry entry in saved)
        {
            if (failures.ContainsKey(entry.Id)) continue;
            Entry now;
            if (!current.TryGetValue(entry.Name, out now))
            {
                failures[entry.Id] = "missing after restore";
            }
            else if (now.Kind != entry.Kind || !SameBytes(now.Data, entry.Data))
            {
                failures[entry.Id] = "content differs after restore" + (now.Kind == EntryKind.Unreadable ? ": " + now.Reason : "");
            }
        }

        var json = new StringBuilder();
        json.Append("{\"seq\":").Append(Native.GetClipboardSequenceNumber());
        json.Append(",\"formats\":").Append(saved.Count);
        json.Append(",\"notRestored\":[");
        bool first = true;
        foreach (Entry entry in saved)
        {
            string reason;
            if (!failures.TryGetValue(entry.Id, out reason)) continue;
            if (!first) json.Append(',');
            first = false;
            json.Append("{\"format\":").Append(JsonString(entry.Name)).Append(",\"reason\":").Append(JsonString(reason)).Append('}');
        }
        json.Append("]}");
        WriteText(Console.OpenStandardOutput(), json.ToString());
        return 0;
    }

    /// <summary>지금 클립보드의 모든 형식을 save 와 같은 꼴로 읽는다 — 이름으로 찾는다.</summary>
    private static Dictionary<string, Entry> ReadCurrent()
    {
        var current = new Dictionary<string, Entry>();
        OpenClipboardWithRetry(IntPtr.Zero);
        try
        {
            foreach (uint id in EnumerateFormats())
            {
                Entry entry = ReadEntry(id);
                current[entry.Name] = entry;
            }
        }
        finally
        {
            Native.CloseClipboard();
        }
        return current;
    }

    private static IntPtr CreateHandle(Entry entry)
    {
        switch (entry.Kind)
        {
            case EntryKind.Bitmap:
                {
                    var header = new byte[40];
                    Buffer.BlockCopy(entry.Data, 0, header, 0, 40);
                    var bits = new byte[entry.Data.Length - 40];
                    Buffer.BlockCopy(entry.Data, 40, bits, 0, bits.Length);
                    IntPtr dc = Native.GetDC(IntPtr.Zero);
                    try
                    {
                        IntPtr bitmap = Native.CreateDIBitmap(dc, header, CBM_INIT, bits, header, DIB_RGB_COLORS);
                        if (bitmap == IntPtr.Zero) throw new Win32Exception("CreateDIBitmap failed");
                        return bitmap;
                    }
                    finally
                    {
                        Native.ReleaseDC(IntPtr.Zero, dc);
                    }
                }
            case EntryKind.EnhMetaFile:
                {
                    IntPtr metafile = Native.SetEnhMetaFileBits((uint)entry.Data.Length, entry.Data);
                    if (metafile == IntPtr.Zero) throw new Win32Exception("SetEnhMetaFileBits failed");
                    return metafile;
                }
            case EntryKind.MetaFilePict:
                {
                    var bits = new byte[entry.Data.Length - 12];
                    Buffer.BlockCopy(entry.Data, 12, bits, 0, bits.Length);
                    IntPtr metafile = Native.SetMetaFileBitsEx((uint)bits.Length, bits);
                    if (metafile == IntPtr.Zero) throw new Win32Exception("SetMetaFileBitsEx failed");
                    var picture = new byte[IntPtr.Size == 8 ? 24 : 16];
                    Buffer.BlockCopy(entry.Data, 0, picture, 0, 12);
                    IntPtr handle = AllocGlobal(picture);
                    IntPtr pointer = Native.GlobalLock(handle);
                    Marshal.WriteIntPtr(pointer, IntPtr.Size == 8 ? 16 : 12, metafile);
                    Native.GlobalUnlock(handle);
                    return handle;
                }
            case EntryKind.Palette:
                {
                    var logPalette = new byte[4 + entry.Data.Length - 2];
                    logPalette[0] = 0x00; // palVersion = 0x300
                    logPalette[1] = 0x03;
                    Buffer.BlockCopy(entry.Data, 0, logPalette, 2, entry.Data.Length);
                    IntPtr palette = Native.CreatePalette(logPalette);
                    if (palette == IntPtr.Zero) throw new Win32Exception("CreatePalette failed");
                    return palette;
                }
            default:
                return AllocGlobal(entry.Data);
        }
    }

    private static IntPtr AllocGlobal(byte[] data)
    {
        IntPtr handle = Native.GlobalAlloc(GMEM_MOVEABLE, new UIntPtr((uint)data.Length));
        if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "GlobalAlloc failed");
        if (data.Length == 0) return handle;
        IntPtr pointer = Native.GlobalLock(handle);
        if (pointer == IntPtr.Zero)
        {
            int error = Marshal.GetLastWin32Error();
            Native.GlobalFree(handle);
            throw new Win32Exception(error, "GlobalLock failed");
        }
        Marshal.Copy(data, 0, pointer, data.Length);
        Native.GlobalUnlock(handle);
        return handle;
    }

    /// <summary>SetClipboardData 가 받지 않은 핸들을 푼다 — 받은 핸들은 OS 가 가진다.</summary>
    private static void FreeHandle(EntryKind kind, IntPtr handle)
    {
        switch (kind)
        {
            case EntryKind.Bitmap:
            case EntryKind.Palette:
                Native.DeleteObject(handle);
                break;
            case EntryKind.EnhMetaFile:
                Native.DeleteEnhMetaFile(handle);
                break;
            case EntryKind.MetaFilePict:
                IntPtr pointer = Native.GlobalLock(handle);
                if (pointer != IntPtr.Zero)
                {
                    Native.DeleteMetaFile(Marshal.ReadIntPtr(pointer, IntPtr.Size == 8 ? 16 : 12));
                    Native.GlobalUnlock(handle);
                }
                Native.GlobalFree(handle);
                break;
            default:
                Native.GlobalFree(handle);
                break;
        }
    }

    // ---- 공용 ----

    /// <summary>다른 프로그램이 클립보드를 잠깐 열어 둔 수 있다 — 얼마동안 다시 시도한다.</summary>
    private static void OpenClipboardWithRetry(IntPtr owner)
    {
        for (int attempt = 0; ; attempt++)
        {
            if (Native.OpenClipboard(owner)) return;
            if (attempt >= 40) throw new Win32Exception(Marshal.GetLastWin32Error(), "OpenClipboard failed");
            Thread.Sleep(50);
        }
    }

    private static bool SameBytes(byte[] left, byte[] right)
    {
        if (left.Length != right.Length) return false;
        for (int index = 0; index < left.Length; index++)
        {
            if (left[index] != right[index]) return false;
        }
        return true;
    }

    private static string JsonString(string value)
    {
        var json = new StringBuilder("\"");
        foreach (char character in value)
        {
            switch (character)
            {
                case '"': json.Append("\\\""); break;
                case '\\': json.Append("\\\\"); break;
                default:
                    if (character < 0x20) json.Append("\\u").Append(((int)character).ToString("x4"));
                    else json.Append(character);
                    break;
            }
        }
        return json.Append('"').ToString();
    }
}
