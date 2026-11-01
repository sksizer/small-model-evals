// Prints the GPU memory budget Metal recommends for this machine, in bytes.
import Metal
print(MTLCreateSystemDefaultDevice()?.recommendedMaxWorkingSetSize ?? 0)
