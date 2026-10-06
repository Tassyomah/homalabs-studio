# Build without Xcode: plain swiftc against the Command Line Tools SDK.
BIN := ../bin/narrate
SRC := Sources/narrate/main.swift

$(BIN): $(SRC)
	@mkdir -p ../bin
	swiftc -O -swift-version 5 -target arm64-apple-macosx14.0 \
	  -framework ScreenCaptureKit -framework AVFoundation -framework AppKit \
	  $(SRC) -o $(BIN)
	@echo built $(BIN)

clean:
	rm -f $(BIN)
