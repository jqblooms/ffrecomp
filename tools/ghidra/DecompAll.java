import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.address.*;
import java.io.*;
public class DecompAll extends GhidraScript {
  public void run() throws Exception {
    String out = getScriptArgs()[0];
    long lo = 0x401000L, hi = 0x462000L;
    DecompInterface d = new DecompInterface();
    d.openProgram(currentProgram);
    PrintWriter pw = new PrintWriter(new FileWriter(out));
    FunctionIterator it = currentProgram.getFunctionManager().getFunctions(true);
    int n=0;
    while (it.hasNext()) {
      Function f = it.next();
      long a = f.getEntryPoint().getOffset();
      if (a < lo || a >= hi) continue;
      DecompileResults r = d.decompileFunction(f, 60, monitor);
      pw.println("// ==== " + f.getName() + " @ " + f.getEntryPoint());
      if (r.decompileCompleted()) pw.println(r.getDecompiledFunction().getC());
      else pw.println("// failed: " + r.getErrorMessage());
      n++;
    }
    pw.close();
    println("decompiled " + n);
  }
}
