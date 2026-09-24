import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.address.*;
import ghidra.app.cmd.function.CreateFunctionCmd;
import ghidra.app.cmd.disassemble.DisassembleCommand;
import java.io.*;
import java.nio.file.*;
public class DecompAt extends GhidraScript {
  public void run() throws Exception {
    String[] a = getScriptArgs();
    java.util.List<String> lines = Files.readAllLines(Paths.get(a[0]));
    // first pass: create functions
    for (String l : lines) {
      l=l.trim(); if (l.isEmpty()) continue;
      Address ad = toAddr(Long.parseLong(l,16));
      if (getFunctionAt(ad)==null) {
        new DisassembleCommand(ad,null,true).applyTo(currentProgram, monitor);
        new CreateFunctionCmd(ad).applyTo(currentProgram, monitor);
      }
    }
    DecompInterface d = new DecompInterface(); d.openProgram(currentProgram);
    PrintWriter pw = new PrintWriter(new FileWriter(a[1]));
    for (String l : lines) {
      l=l.trim(); if (l.isEmpty()) continue;
      Function f = getFunctionAt(toAddr(Long.parseLong(l,16)));
      if (f==null) { pw.println("// ==== NOFUNC @ "+l); continue; }
      DecompileResults r = d.decompileFunction(f, 60, monitor);
      pw.println("// ==== " + f.getName() + " @ " + f.getEntryPoint());
      pw.println(r.decompileCompleted()? r.getDecompiledFunction().getC() : "// failed");
    }
    pw.close();
  }
}
