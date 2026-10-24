import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.util.Base64;
import java.util.Properties;

// Single-source Java launcher: private key material never enters shell arguments or stdout.
class SignWebUpdate {
    public static void main(String[] args) throws Exception {
        Properties config = new Properties();
        try (var input = Files.newInputStream(Path.of(args[0]))) { config.load(input); }
        char[] password = config.getProperty("storePassword").toCharArray();
        KeyStore store = KeyStore.getInstance("PKCS12");
        try (var input = Files.newInputStream(Path.of(config.getProperty("storeFile")))) { store.load(input, password); }
        PrivateKey key = (PrivateKey)store.getKey(config.getProperty("keyAlias"), config.getProperty("keyPassword").toCharArray());
        Signature signature = Signature.getInstance("SHA256withRSA");
        signature.initSign(key);
        signature.update(Files.readAllBytes(Path.of(args[1])));
        System.out.print(Base64.getEncoder().encodeToString(signature.sign()));
        java.util.Arrays.fill(password, '\0');
    }
}
