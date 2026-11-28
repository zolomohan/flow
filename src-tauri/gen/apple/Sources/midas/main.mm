#import <Foundation/Foundation.h>
#include <stdlib.h>
#include "bindings/bindings.h"

int main(int argc, char * argv[]) {
	@autoreleasepool {
		// The book lives in the App Group container, where the share
		// extension, the widgets and the Log transaction intent can open it
		// too. Nil until the App Group entitlement is signed in, and then the
		// Rust side keeps the book in the app's own data folder as before.
		NSURL *group = [[NSFileManager defaultManager]
			containerURLForSecurityApplicationGroupIdentifier:@"group.com.mohanraj.midas"];
		if (group != nil) {
			setenv("FLOW_BOOK_DIR", group.path.fileSystemRepresentation, 1);
		}
	}
	ffi::start_app();
	return 0;
}
